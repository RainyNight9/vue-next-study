import { isObject, toRawType, def } from '@vue/shared'
import {
  mutableHandlers, // 可变数据代理处理
  readonlyHandlers, // 只读(不可变)数据代理处理
  shallowReactiveHandlers, // 浅观察处理（只观察目标对象的第一层属性）
  shallowReadonlyHandlers // 浅观察 && 只读处理
} from './baseHandlers'

// collections 指 Set, Map, WeakMap, WeakSet
import {
  mutableCollectionHandlers, // 可变集合数据代理处理
  readonlyCollectionHandlers, // 只读集合数据代理处理
  shallowCollectionHandlers,
  shallowReadonlyCollectionHandlers
} from './collectionHandlers'

// 泛型类型
import { UnwrapRefSimple, Ref } from './ref'

// 定义的几个用来标记目标对象 target 的类型的flag
export const enum ReactiveFlags {
  SKIP = '__v_skip',
  IS_REACTIVE = '__v_isReactive',
  IS_READONLY = '__v_isReadonly',
  RAW = '__v_raw'
}

export interface Target {
  [ReactiveFlags.SKIP]?: boolean // 不做响应式处理的数据
  [ReactiveFlags.IS_REACTIVE]?: boolean // target 是否是响应式
  [ReactiveFlags.IS_READONLY]?: boolean // target 是否是只读的
  [ReactiveFlags.RAW]?: any // 表示 proxy 对应的源数据，target 已经是 proxy 对象时会有该属性
}

export const reactiveMap = new WeakMap<Target, any>()
export const shallowReactiveMap = new WeakMap<Target, any>()
export const readonlyMap = new WeakMap<Target, any>()
export const shallowReadonlyMap = new WeakMap<Target, any>()

const enum TargetType {
  INVALID = 0,
  COMMON = 1,
  COLLECTION = 2
}

function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}

function getTargetType(value: Target) {
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value)) // toRawType 获取数据的类型名称
}

// only unwrap nested ref
export type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRefSimple<T>

/**
 * Creates a reactive copy of the original object.
 *
 * The reactive conversion is "deep"—it affects all nested properties. In the
 * ES2015 Proxy based implementation, the returned proxy is **not** equal to the
 * original object. It is recommended to work exclusively with the reactive
 * proxy and avoid relying on the original object.
 *
 * A reactive object also automatically unwraps refs contained in it, so you
 * don't need to use `.value` when accessing and mutating their value:
 *
 * ```js
 * const count = ref(0)
 * const obj = reactive({
 *   count
 * })
 *
 * obj.count++
 * obj.count // -> 1
 * count.value // -> 1
 * ```
 */
// 函数类型声明，接受一个对象，返回不会深度嵌套的Ref数据
export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>
// 具体函数实现
export function reactive(target: object) {
  // if trying to observe a readonly proxy, return the readonly version.
  // 如果目标对象已经是只读代理 返回只读代理对象
  if (target && (target as Target)[ReactiveFlags.IS_READONLY]) {
    return target
  }
  return createReactiveObject(
    target, // 响应式处理的目标对象
    false, // 是否为只读
    mutableHandlers, // 对普通数据(除ES6新增的数组集合) 拦截处理方法
    mutableCollectionHandlers, // 对ES6新增的数组集合拦截处理方法
    reactiveMap // 存储对应响应对象 为了后面可以防止重复调用
  )
}

export declare const ShallowReactiveMarker: unique symbol

export type ShallowReactive<T> = T & { [ShallowReactiveMarker]?: true }

/**
 * Return a shallowly-reactive copy of the original object, where only the root
 * level properties are reactive. It also does not auto-unwrap refs (even at the
 * root level).
 */
export function shallowReactive<T extends object>(
  target: T
): ShallowReactive<T> {
  return createReactiveObject(
    target,
    false,
    shallowReactiveHandlers,
    shallowCollectionHandlers,
    shallowReactiveMap
  )
}

type Primitive = string | number | boolean | bigint | symbol | undefined | null
type Builtin = Primitive | Function | Date | Error | RegExp
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Map<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends ReadonlyMap<infer K, infer V>
  ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends WeakMap<infer K, infer V>
  ? WeakMap<DeepReadonly<K>, DeepReadonly<V>>
  : T extends Set<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : T extends ReadonlySet<infer U>
  ? ReadonlySet<DeepReadonly<U>>
  : T extends WeakSet<infer U>
  ? WeakSet<DeepReadonly<U>>
  : T extends Promise<infer U>
  ? Promise<DeepReadonly<U>>
  : T extends Ref<infer U>
  ? Ref<DeepReadonly<U>>
  : T extends {}
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : Readonly<T>

/**
 * Creates a readonly copy of the original object. Note the returned copy is not
 * made reactive, but `readonly` can be called on an already reactive object.
 */
// 函数声明+实现，接受一个对象，返回一个只读的响应式数据
export function readonly<T extends object>(
  target: T
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true,
    readonlyHandlers,
    readonlyCollectionHandlers,
    readonlyMap
  )
}

/**
 * Returns a reactive-copy of the original object, where only the root level
 * properties are readonly, and does NOT unwrap refs nor recursively convert
 * returned properties.
 * This is used for creating the props proxy object for stateful components.
 */
export function shallowReadonly<T extends object>(
  target: T
): Readonly<{ [K in keyof T]: UnwrapNestedRefs<T[K]> }> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers,
    shallowReadonlyCollectionHandlers,
    shallowReadonlyMap
  )
}

// 核心函数
function createReactiveObject(
  target: Target, // 响应式处理的目标对象
  isReadonly: boolean, // 是否为只读
  baseHandlers: ProxyHandler<any>, // 对普通数据(除ES6新增的数组集合) 拦截处理方法
  collectionHandlers: ProxyHandler<any>, // 对ES6新增的数组集合拦截处理方法
  proxyMap: WeakMap<Target, any> // 存储对应响应对象 为了后面可以防止重复调用
) {
  // reactive不会对基础数据类型进行响应式处理
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  // 如果是目标已经响应式处理了 直接返回
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }

  // target already has corresponding Proxy
  // 判断是否存在该对象的响应式对象 存在返回 
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }

  // only a whitelist of value types can be observed.
  /* 
   获取目标对象的数据类型 (如果是 new Number() 等使用构造函数方式创建的数据和变量在前面判断也会是对象，
   但是如果使用Object原型上的toString去判断就不是对象，而是普通类型值，如：number、string等)
   可能是数组集合 或者是 object array 等对象 使用不同的拦截处理方法
  */
 // 不做响应式的，直接返回
  const targetType = getTargetType(target)
  // TargetType.INVALID 无效对象 直接返回
  if (targetType === TargetType.INVALID) {
    return target
  }

  // 核心代码：创建 target 代理
  const proxy = new Proxy(
    target,
    // TargetType.COLLECTION 数组集合标识
    // collectionHandlers 处理 Map、Set、WeakMap、WeakSet
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  // 存储响应式对象后返回相应是对象
  proxyMap.set(target, proxy)
  return proxy
}

export function isReactive(value: unknown): boolean {
  if (isReadonly(value)) {
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}

export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

export function isProxy(value: unknown): boolean {
  return isReactive(value) || isReadonly(value)
}

export function toRaw<T>(observed: T): T {
  const raw = observed && (observed as Target)[ReactiveFlags.RAW]
  return raw ? toRaw(raw) : observed
}

export function markRaw<T extends object>(value: T): T {
  def(value, ReactiveFlags.SKIP, true)
  return value
}

// 转化成响应式代理对象
export const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value

// 转换成只读代理对象
export const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value as Record<any, any>) : value
