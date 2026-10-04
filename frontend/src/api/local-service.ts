import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModules } from '@/data/local-store'
import { useSessionStore } from '@/stores/session'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 终态：进入这些状态的记录生命周期已结束，不允许再执行任何动作（比如已停用的设备不能再报修）。
const TERMINAL_STATUSES = ['已停用', '已撤销', '已废止']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

// 每个模块的字段里都登记了一个「××状态」字段，它和 row.status 是同一份状态的两处存放：
// 写入时必须一起改，否则详情列、导出清单回显的还是旧状态。
function statusFieldOf(meta: ModuleMeta): string | undefined {
  return meta.fields.find((field) => field.endsWith('状态'))
}

// pending / abnormal 的唯一口径：由当前状态对照模块元数据推导，行上存的只是同一份结果的快照。
function isPending(meta: ModuleMeta, status: string): boolean {
  return meta.pendingStatuses.includes(status)
}

function isAbnormal(meta: ModuleMeta, status: string): boolean {
  return meta.abnormalStatuses.includes(status)
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

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

// 顺着已有编号的「前缀-数字」格式取下一个，没有历史编号时用模块默认前缀从 1 开始。
function nextCode(rows: EntryRow[], field: string, fallbackPrefix: string): string {
  let prefix = fallbackPrefix
  let max = 0
  for (const row of rows) {
    const match = /^(.*?)(\d+)$/.exec(String(row[field] ?? ''))
    if (!match) {
      continue
    }
    prefix = match[1]
    max = Math.max(max, Number(match[2]))
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

// 维修核查记录缺巡检人员时回填当前值班人；拿不到会话（比如纯数据层被单独调用）就用默认值班员。
function currentOperator(): string {
  try {
    const operator = useSessionStore().operator
    return operator || '值班管理员'
  } catch {
    return '值班管理员'
  }
}

type FollowUp = {
  key: string
  build: (rows: EntryRow[]) => EntryRow[]
}

// 联动核查：遥测设备确认修复后，在巡检记录里同步补一条修复核查。
// 只新增、不改旧记录——历史巡检的发现与结论保持原样。
const FOLLOW_UPS: Record<string, Record<string, (row: EntryRow) => FollowUp>> = {
  telemetry: {
    确认修复: (device) => ({
      key: 'inspection',
      build: (rows) => {
        const meta = moduleMeta('inspection')
        const status = '已巡检'
        const deviceCode = String(device['设备编号'] ?? '')
        const record: EntryRow = {
          id: nextId(rows),
          status,
          pending: isPending(meta, status),
          abnormal: isAbnormal(meta, status),
          记录编号: nextCode(rows, '记录编号', 'INSP-'),
          站点编号: String(device['所属站点'] ?? ''),
          巡检日期: today(),
          巡检人员: currentOperator(),
          检查项目: `遥测设备${deviceCode}修复核查`,
          发现问题: '无',
          处理措施: `确认修复：${deviceCode}`,
          巡检状态: status,
        }
        return [...rows, record]
      },
    }),
  },
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (TERMINAL_STATUSES.includes(current)) {
    return { ok: false, message: `${meta.entity}已处于「${current}」，不能再执行「${action}」` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const statusField = statusFieldOf(meta)
  const updated: EntryRow = {
    ...rows[index],
    ...(statusField ? { [statusField]: target } : {}),
    status: target,
    pending: isPending(meta, target),
    abnormal: isAbnormal(meta, target),
  }
  const nextRows = [...rows]
  nextRows[index] = updated
  try {
    // 主记录和联动记录放进同一个补丁一次落盘：任何一处写失败，saveModules 整体回退。
    const patch: Record<string, EntryRow[]> = { [key]: nextRows }
    const followUp = FOLLOW_UPS[key]?.[action]?.(updated)
    if (followUp) {
      const baseRows = patch[followUp.key] ?? listRows(followUp.key)
      patch[followUp.key] = followUp.build(baseRows)
    }
    saveModules(patch)
  } catch {
    return { ok: false, message: `${meta.entity}「${action}」写入失败，已整体回退，请重试` }
  }
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
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
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      // 看板直接按当前状态推导，不读行上可能过期的快照，修复后不再残留旧故障。
      pending: entries.filter((row) => isPending(meta, String(row.status))).length,
      abnormal: entries.filter((row) => isAbnormal(meta, String(row.status))).length,
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
