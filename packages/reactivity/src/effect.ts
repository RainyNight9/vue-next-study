import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>

// targetMap 为依赖管理中心，用于存储响应式函数、目标对象、键之间的映射关系
// 相当于这样
// targetMap(weakmap)={
//    target1(map):{
//      key1(dep):[effect1,effect2]
//      key2(dep):[effect1,effect2]
//    }
// }
// 给每个 target 创建一个 map，每个 key 对应着一个 dep
// 用 dep 来收集依赖函数，监听 key 值变化，触发 dep 中的依赖函数
const targetMap = new WeakMap<any, KeyToDepMap>()

// The number of effects currently being tracked recursively.
let effectTrackDepth = 0

export let trackOpBit = 1

/**
 * The bitwise track markers support at most 30 levels of recursion.
 * This value is chosen to enable modern JS engines to use a SMI on all platforms.
 * When recursion depth is greater, fall back to using a full cleanup.
 */
// 最大嵌套深度
const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}

// 临时存储响应式函数
const effectStack: ReactiveEffect[] = []
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export class ReactiveEffect<T = any> {
  active = true
  deps: Dep[] = []

  // can be attached after creation
  computed?: boolean
  allowRecurse?: boolean
  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope | null
  ) {
    recordEffectScope(this, scope)
  }

  run() {
    if (!this.active) {
      return this.fn()
    }

    // 如果栈中没有当前的 effect
    if (!effectStack.includes(this)) {
      try {
        // activeEffect 表示当前依赖收集系统正在处理的 effect
        // 先把当前 effect 设置为全局全局激活的 effect，在 getter 中会收集 activeEffect 持有的 effect
        // 然后入栈
        effectStack.push((activeEffect = this))
        // 恢复依赖收集，因为在setup 函数自行期间，会暂停依赖收集
        enableTracking()

        // 记录递归深度位数
        trackOpBit = 1 << ++effectTrackDepth

        // 如果 effect 嵌套层数没有超过 30 层，一般超不了
        if (effectTrackDepth <= maxMarkerBits) {
          // 给依赖打标记，就是遍历 _effect 实例中的 deps 属性，给每个 dep 的 w 属性标记为 trackOpBit 的值
          initDepMarkers(this)
        } else {
          // 超过就 清除当前 effect 相关依赖 通常情况下不会
          cleanupEffect(this)
        }
        // 在执行 effect 函数，比如访问 target[key]，会触发 getter
        return this.fn()
      } finally {
        if (effectTrackDepth <= maxMarkerBits) {
          // 完成依赖标记
          finalizeDepMarkers(this)
        }

        // 恢复到上一级
        trackOpBit = 1 << --effectTrackDepth

        // 重置依赖收集状态
        resetTracking()
        // 出栈
        effectStack.pop()
        // 获取栈长度
        const n = effectStack.length
        // 将当前 activeEffect 指向栈最后一个 effect
        activeEffect = n > 0 ? effectStack[n - 1] : undefined
      }
    }
  }

  stop() {
    if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

function cleanupEffect(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean
  scheduler?: EffectScheduler
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  // 如果已经是 effect 函数，就直接拿原来的
  if ((fn as ReactiveEffectRunner).effect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }

  // 使用 new ReactiveEffect 创建了一个 _effect 实例，ReactiveEffect 看一下
  const _effect = new ReactiveEffect(fn)
  if (options) {
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }

  // 如果 lazy 不为真就直接执行一次 effect。计算属性的 lazy 为 true
  if (!options || !options.lazy) {
    // 立刻执行，触发依赖收集
    _effect.run()
  }

  // 在执行副作用函数 effect 方法时，实际上执行的就是这个 run 方法，run 看一下
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

let shouldTrack = true

// 依赖收集栈
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// 先看 targetMap，再看本 收集函数
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // 如果当前没有激活 effect，就不用收集
  if (!isTracking()) {
    return
  }
  // 从依赖管理中心里获取 target
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    // 如果没有就创建一个
    targetMap.set(target, (depsMap = new Map()))
  }
  // 获取 key 对应的 dep 集合
  let dep = depsMap.get(key)
  if (!dep) {
    // 没有就创建
    depsMap.set(key, (dep = createDep()))
  }

// 开发环境和非开发环境
  const eventInfo = __DEV__
    ? { effect: activeEffect, target, type, key }
    : undefined

  trackEffects(dep, eventInfo)
}

export function isTracking() {
  return shouldTrack && activeEffect !== undefined
}

// dep.n：n 是 newTracked 的缩写，表示是否是最新收集的(是否当前层)
// dep.w：w 是 wasTracked 的缩写，表示是否已经被收集，避免重复收集
export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  // 如果 effect 嵌套层数没有超过 30 层
  if (effectTrackDepth <= maxMarkerBits) {
    if (!newTracked(dep)) {
      // 标记新依赖 |= 位运算符
      dep.n |= trackOpBit // set newly tracked
      // 已经被收集的依赖不需要重复收集
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // Full cleanup mode.
    // 超过了 就切换清除依赖模式
    shouldTrack = !dep.has(activeEffect!)
  }

  // 如果可以收集
  if (shouldTrack) {
    // 收集当前激活的 effect 作为依赖
    dep.add(activeEffect!)
    // 当前激活的 effect 收集 dep 集合， !. ts语法
    activeEffect!.deps.push(dep)

    // 开发环境下触发 onTrack 事件
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        Object.assign(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo
        )
      )
    }
  }
}

// trigger 是 track 收集的依赖对应的触发器，也就是负责根据映射关系，获取响应式函数，
// 再派发通知 triggerEffects 进行更新
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 从依赖管理中心中获取依赖
  const depsMap = targetMap.get(target)
  // 没有被收集过的依赖，直接返回
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  // 触发trigger 的时候传进来的类型是清除类型
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    // 往队列中添加关联的所有依赖，准备清除
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    // 如果是数组类型的，并且是数组的 length 改变时
    depsMap.forEach((dep, key) => {
      // 如果数组长度变短时，需要做已删除数组元素的 effects 和 trigger
      // 也就是索引号 >= 数组最新的length的元素们对应的 effects，要将它们添加进队列准备清除
      if (key === 'length' || key >= (newValue as number)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 如果 key 不是 undefined，就添加对应依赖到队列，比如新增、修改、删除
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 新增、修改、删除分别处理
    switch (type) {
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // new index added to array -> length changes
          deps.push(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }
  // 到这里就拿到了 targetMap[target][key]，并存到 deps 里
  // 接着是要将对应的 effect 取出，调用 triggerEffects 执行

  
  // 判断开发环境，传入eventInfo
  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    const effects: ReactiveEffect[] = []
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

// 执行 effect 函数，也就是『派发更新』中的更新了
export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  // 遍历 effect 的集合函数
  for (const effect of isArray(dep) ? dep : [...dep]) {
    /** 
      这里判断 effect !== activeEffect的原因是：不能和当前effect 相同
      比如：count.value++，如果这是个effect，会触发getter，track收集了当前激活的 effect，
      然后count.value = count.value+1 会触发setter，执行trigger，
      就会陷入一个死循环，所以要过滤当前的 effect
    */
    if (effect !== activeEffect || effect.allowRecurse) {
      if (__DEV__ && effect.onTrigger) {
        effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
      }
      // 如果 scheduler 就执行，计算属性有 scheduler
      if (effect.scheduler) {
        effect.scheduler()
      } else {
        // 执行 effect 函数
        effect.run()
      }
    }
  }
}
