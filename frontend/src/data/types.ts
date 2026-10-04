/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

// 指标取值方式：总数 / 待处理 / 异常 / 恒为 0 / 直接按某个状态计数。
export type MetricValueKind = 'total' | 'pending' | 'abnormal' | 'zero' | string

export type MetricSpec = {
  label: string
  value: MetricValueKind
}

// 跨模块联动：例如遥测设备确认修复后，巡检模块里仍挂着的故障事项要一并核销。
export type ActionCascade = {
  module: string
  whenStatus: string
  action: string
  // 仅在目标字段为空时回填（$operator=当前值班人），非空的旧结论一律保留。
  fill?: Record<string, string>
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  // 每个动作允许从哪些状态发起；不在清单里的状态一律拒绝（停用设备不得再报修）。
  actionSources: Record<string, string[]>
  // 已办结状态：不在清单内才算待处理，不再按状态位置猜。
  doneStatuses: string[]
  // 异常状态：看板异常量只认这里的语义，不再按动作动词猜。
  abnormalStatuses: string[]
  metrics: MetricSpec[]
  // 动作执行时在主记录上盖章的字段（如维修人员、最近维护日）。
  actionStamp?: Record<string, Record<string, string>>
  actionCascades?: Record<string, ActionCascade[]>
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
