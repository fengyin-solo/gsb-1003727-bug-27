import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, commitRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { currentOperator } from '@/stores/session'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 状态的派生标志只认元数据里登记的语义，不再按状态位置或动作动词猜测。
export function isPendingStatus(meta: ModuleMeta, status: string): boolean {
  return !meta.doneStatuses.includes(status)
}

export function isAbnormalStatus(meta: ModuleMeta, status: string): boolean {
  return meta.abnormalStatuses.includes(status)
}

// 每个模块末列是该模块业务状态的镜像（如遥测的「设备状态」、巡检的「巡检状态」），
// 它必须与规范字段 status 同源；任何状态写入都同步刷镜像，详情回显就不会残留旧故障。
function mirrorField(meta: ModuleMeta): string | null {
  const last = meta.fields[meta.fields.length - 1]
  return last && /状态$/.test(last) ? last : null
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

function resolveToken(token: string): string {
  if (token === '$operator') {
    return currentOperator()
  }
  if (token === '$today') {
    return todayText()
  }
  return token
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 页面据此决定动作按钮是否可点，与服务端守卫同一套来源规则，避免停用设备还能报修。
export function canRunAction(meta: ModuleMeta, action: string, status: string): boolean {
  return (meta.actionSources[action] ?? []).includes(status)
}

// 指标卡取数：总数 / 待处理 / 异常 / 指定状态计数，避免页面写死成 0。
export function metricValue(
  meta: ModuleMeta,
  spec: ModuleMeta['metrics'][number],
  rows: EntryRow[],
): number {
  if (spec.value === 'total') {
    return rows.length
  }
  if (spec.value === 'pending') {
    return rows.filter((row) => isPendingStatus(meta, String(row.status))).length
  }
  if (spec.value === 'abnormal') {
    return rows.filter((row) => isAbnormalStatus(meta, String(row.status))).length
  }
  if (spec.value === 'zero') {
    return 0
  }
  return rows.filter((row) => String(row.status) === spec.value).length
}

function applyStatus(meta: ModuleMeta, row: EntryRow, status: string): EntryRow {
  const next: EntryRow = {
    ...row,
    status,
    pending: isPendingStatus(meta, status),
    abnormal: isAbnormalStatus(meta, status),
  }
  const mirror = mirrorField(meta)
  if (mirror) {
    next[mirror] = status
  }
  return next
}

// 状态流转是一次事务：主记录 + 联动模块的事项一起在内存里改好，
// 最后只提交一次；任何一步写不进去（如 localStorage 抛错）整体回退。
export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }

  const snapshots: Record<string, EntryRow[]> = { [key]: [...listRows(key)] }
  const index = snapshots[key].findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }

  const current = String(snapshots[key][index].status)
  // 重复操作只产生一个状态：已经是目标态直接幂等返回，不再写第二遍。
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  if (!canRunAction(meta, action, current)) {
    return { ok: false, message: `${meta.entity}当前为「${current}」，不能执行「${action}」` }
  }

  let primary = applyStatus(meta, snapshots[key][index], target)
  for (const [field, token] of Object.entries(meta.actionStamp?.[action] ?? {})) {
    primary = { ...primary, [field]: resolveToken(token) }
  }
  snapshots[key][index] = primary

  const touched = new Set<string>([key])
  const cascadeNotes: string[] = []
  for (const cascade of meta.actionCascades?.[action] ?? []) {
    const other = moduleMeta(cascade.module)
    if (!touched.has(cascade.module)) {
      snapshots[cascade.module] = [...listRows(cascade.module)]
      touched.add(cascade.module)
    }
    const cascadeTarget = other.actionTargets[cascade.action]
    let linked = 0
    snapshots[cascade.module] = snapshots[cascade.module].map((row) => {
      if (String(row.status) !== cascade.whenStatus) {
        return row
      }
      linked += 1
      let updated = applyStatus(other, row, cascadeTarget)
      for (const [field, token] of Object.entries(cascade.fill ?? {})) {
        // 维修历史缺人员：只回填当前还空着的字段，旧记录已有结论的原样保留。
        if (String(updated[field] ?? '').trim() === '') {
          updated = { ...updated, [field]: resolveToken(token) }
        }
      }
      return updated
    })
    if (linked > 0) {
      cascadeNotes.push(`同步${other.name}${linked}条「${cascade.whenStatus}」事项为「${cascadeTarget}」`)
    }
  }

  try {
    commitRows([...touched].map((moduleKey) => [moduleKey, snapshots[moduleKey]]))
  } catch (error) {
    // 并发修复只生效一次：提交前用的是最新已提交快照做守卫；提交失败则整单回退。
    return {
      ok: false,
      message: error instanceof Error ? error.message : '状态写入失败，已整体回退',
    }
  }

  const suffix = cascadeNotes.length > 0 ? `，${cascadeNotes.join('，')}` : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  // 看板按状态语义实时派生待处理/异常量：旧记录里存的历史标志不再作数，修复后立即刷新。
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => isPendingStatus(meta, String(row.status))).length,
      abnormal: entries.filter((row) => isAbnormalStatus(meta, String(row.status))).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
