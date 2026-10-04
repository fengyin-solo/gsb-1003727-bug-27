import { defineStore } from 'pinia'

// 服务层（动作盖章/联动回填）需要拿到当前值班人，但它运行在组件之外，
// 直接 useSessionStore() 在 Pinia 未安装时会抛错，这里统一兜一个默认值班人。
export function currentOperator(fallback = '值班管理员'): string {
  try {
    const operator = useSessionStore().operator
    return operator.trim() || fallback
  } catch {
    return fallback
  }
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '水文监测站网管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
  },
})
