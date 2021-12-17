import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  extend,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  Object.getOwnPropertyNames(Symbol)
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

// 最后通过 这个方法生成一些get拦截方法
const get = /*#__PURE__*/ createGetter() // 可变数据的拦截代理get方法
const shallowGet = /*#__PURE__*/ createGetter(false, true) // 浅层次可变数据的拦截代理get方法
const readonlyGet = /*#__PURE__*/ createGetter(true) // 不可变数据的拦截代理方法
const shallowReadonlyGet = /*#__PURE__*/ createGetter(true, true) // 浅层次的不可变数据的拦截代理方法
// /*#__PURE__*/ 纯函数的意思，也就是webpack压缩（tree-shaking摇树）的时候，
// 如果看到/*#__PURE__*/这个标志，说明他是纯函数，如果没有调用它，会直接把它删除了，减少代码体积

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

// 如果使用数组原生方法去改变数组，那必然会被会触发两次set 甚至于无限调用，
// 所以vue3.2对数组的5个改变数组本身的方法进行劫持
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
  // instrument identity-sensitive Array methods to account for possible reactive
  // values
  // 3个判断数组中是否存在某值的方法
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      const arr = toRaw(this) as any
      // 收集依赖
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      // we run the method using the original args first (which may be reactive)
      // 使用传递进来的参数第一次运行方法 (参数可能是代理对象, 会找不到结果) 找到了结果 返回即可
      const res = arr[key](...args)
      if (res === -1 || res === false) {
        // if that didn't work, run it again using raw values.
        // 将代理对象转换成原始数据 并再一次运行 且返回
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })
  // instrument length-altering mutation methods to avoid length being tracked
  // which leads to infinite loops in some cases (#2137)
  // 5个会修改数组本身的方法
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // 在vue3.0版本 vue会对数组的push等方法进行依赖收集和触发 可能产生无限循环调用 这里让数组的push等方法不进行依赖的收集和触发
      /**
       * watachEffect(() => {
       *  arr.push(1)
       * })
       * 
       * watchEffect(() => {
       *  arr.push(2)
       * })
       */
      pauseTracking()
      // 执行数组原生上的方法 将结果返回
      const res = (toRaw(this) as any)[key].apply(this, args)
      resetTracking()
      return res
    }
  })
  // 也就是说在调用原生方法改变数组时，不会再去收集依赖和触发依赖进行更新 
  // 而是统一调用 每一个组件唯一的挂载 更新函数
  return instrumentations
}

function createGetter(isReadonly = false, shallow = false) {
  return function get(target: Target, key: string | symbol, receiver: object) {
    // 访问对应标记位
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (
      // 代理对象已经存在 返回即可 (有四个集合分别存储不同的代理对象)
      // receiver 指向调用者，这里判断是为了保证触发拦截 handle 的是 proxy 本身而不是 proxy 的继承者
      // 触发拦的两种方式：一是访问 proxy 对象本身的属性，二是访问对象原型链上有 proxy 对象的对象的属性，因为查询会沿着原型链向下找
      key === ReactiveFlags.RAW &&
      receiver ===
        (isReadonly
          ? shallow
            ? shallowReadonlyMap
            : readonlyMap
          : shallow
          ? shallowReactiveMap
          : reactiveMap
        ).get(target)
    ) {
      // 返回 target 本身，也就是响应式对象的原始值
      return target
    }

    // 是否是数组
    const targetIsArray = isArray(target)

    // 不是只读类型 && 是数组 && 触发的是 arrayInstrumentations 工具集里的方法
    if (!isReadonly && targetIsArray && hasOwn(arrayInstrumentations, key)) {
      // 通过 proxy 调用，arrayInstrumentations[key]的this一定指向 proxy
      return Reflect.get(arrayInstrumentations, key, receiver)
    }

    // 映射到原始对象上，proxy 预返回值
    const res = Reflect.get(target, key, receiver)
        
    // 做了一些验证 不能是Symbol 不能是特殊属性(__proto__,__v_isRef,__isVue)
    // 也就是说，key 是 symbol 或访问的是__proto__属性不做依赖收集和递归响应式处理，直接返回结果
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }

    // 不是只读类型的 target 就收集依赖。
    // 因为只读类型不会变化，无法触发 setter，也就会触发更新
    if (!isReadonly) {
      // 收集依赖，存储到对应的全局仓库中
      track(target, TrackOpTypes.GET, key)
    }

    // 浅比较，不做递归转化，就是说对象有属性值还是对象的话不递归调用 reactive()
    if (shallow) {
      return res
    }

    // 访问的属性已经是 ref 对象
    // 如果值是数组、或者是带有数字为键的对象的ref对象，不能展开直接返回
    if (isRef(res)) {
      // ref unwrapping - does not apply for Array + integer key.
      const shouldUnwrap = !targetIsArray || !isIntegerKey(key)
      // 返回 ref.value，数组除外
      return shouldUnwrap ? res.value : res
    }

    // 如果获取值不是对象直接返回即可
    // 否则根据isReadonly返回响应式数据
    // 这里做了懒加载处理 到这里之前获取目标的内部数据都不是响应式
    // 这里是对是对象的内部数据的响应式处理 然后返回代理对象
    if (isObject(res)) {
      // Convert returned value into a proxy as well. we do the isObject check
      // here to avoid invalid value warning. Also need to lazy access readonly
      // and reactive here to avoid circular dependency.
      // 由于 proxy 只能代理一层，如果子元素是对象，需要递归继续代理
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

// 通过这个方法生成下面两个set方法
const set = /*#__PURE__*/ createSetter() // 可变数据的拦截set方法
const shallowSet = /*#__PURE__*/ createSetter(true) // 浅层次的可变数据的拦截set方法

function createSetter(shallow = false) {
  return function set(
    target: object, // 目标数据
    key: string | symbol, // 键值
    value: unknown, // 新的属性值
    receiver: object // target 的代理对象
  ): boolean {
    // 获取旧的属性值
    let oldValue = (target as any)[key]
    // 只有不是浅层次 和只读的 
    if (!shallow && !isReadonly(value)) {
      // 拿新值和老值的原始值，因为新传入的值可能是响应式数据，如果直接和 target 上原始值比较是没有意义的
      value = toRaw(value)
      oldValue = toRaw(oldValue)
      // 旧值是ref类型 新值不是 直接在旧值上修改
      // 不是数组 && 老值是 ref && 新值不是 ref，更新 ref.value 为新值
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
      // 在浅层模式下 不管是不是代理对象 都按默认设置
    }

    // 看看key值的存在于对象中？ 
    const hadKey =
      isArray(target) && isIntegerKey(key) // 是数组 且 key是整数类型
        ? Number(key) < target.length // 数组索引不能大于数组的长度
        : hasOwn(target, key) // key值存在于存在对象？

    // 映射的原始对象上，赋值，相当于 target[key] = value
    const result = Reflect.set(target, key, value, receiver)
    // don't trigger if target is something up in the prototype chain of original
    // receiver 必须是target 的代理对象 才会触发 trigger
    // Receiver：最初被调用的对象。通常是 proxy 本身，
    // 但 handler 的 set 方法也有可能在原型链上或以其他方式被间接地调用（因此不一定是 proxy 本身）
    if (target === toRaw(receiver)) {
      // 存在旧值 修改 不存在 新增
      if (!hadKey) {
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }
}

// 拦截删除数据
function deleteProperty(target: object, key: string | symbol): boolean {
  // 判断key键是否存在 然后删除操作
  const hadKey = hasOwn(target, key)
  const oldValue = (target as any)[key]
  const result = Reflect.deleteProperty(target, key)
  // 只有key键存在 删除成功了才会进行更新
  if (result && hadKey) {
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

// 判断是否存在
function has(target: object, key: string | symbol): boolean {
  const result = Reflect.has(target, key)
  // isSymbol不是唯一值 builtInSymbols 不是Symbol原型上的12个方法
  if (!isSymbol(key) || !builtInSymbols.has(key)) {
    track(target, TrackOpTypes.HAS, key)
  }
  return result
}

// 拿到自身所有属性组成的数组
function ownKeys(target: object): (string | symbol | number)[] {
  track(target, TrackOpTypes.ITERATE, isArray(target) ? 'length' : ITERATE_KEY)
  return Reflect.ownKeys(target)
}

// get、has、ownKeys 会触发依赖收集 track()
// set、deleteProperty 会触发更新 trigger()
export const mutableHandlers: ProxyHandler<object> = {
  get, // 获取属性
  set, // 修改属性
  deleteProperty, // 删除属性
  has, // 是否拥有某个属性
  ownKeys // 收集 key，包括 symbol 类型或者不可枚举的 key
}

export const readonlyHandlers: ProxyHandler<object> = {
  get: readonlyGet,
  set(target, key) {
    if (__DEV__) {
      console.warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  },
  deleteProperty(target, key) {
    if (__DEV__) {
      console.warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

export const shallowReactiveHandlers = /*#__PURE__*/ extend(
  {},
  mutableHandlers,
  {
    get: shallowGet,
    set: shallowSet
  }
)

// Props handlers are special in the sense that it should not unwrap top-level
// refs (in order to allow refs to be explicitly passed down), but should
// retain the reactivity of the normal readonly object.
export const shallowReadonlyHandlers = /*#__PURE__*/ extend(
  {},
  readonlyHandlers,
  {
    get: shallowReadonlyGet
  }
)
