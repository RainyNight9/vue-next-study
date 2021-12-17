// 临时存储响应式函数
const effectStack = []

// 存放响应式函数和目标、键之间的映射关系
const targetMap = new WeakMap()

// 传入对象应该是一个非 null 的 object
const isObject = obj => typeof obj === 'object' && obj !== null

// vue-next/packages/reactivity/src/baseHandlers.ts
const baseHandler = {
  get(target, key, receiver) {
    let res = Reflect.get(target, key, receiver)
    // 判断 res 是对象，递归处理它
    res = isObject(res) ? reactive(res) : res
    // 在触发 get 的时候进行依赖收集
    track(target, key);
    console.log(`获取${key.toString()}: ${res}`)
    return res
  },
  set(target, key, value, receiver) {
    const res = Reflect.set(target, key, value, receiver)
    console.log(`设置${key.toString()}: ${value}`)
    // 在触发 set 的时候进行触发依赖
    trigger(target, key);
    return res
  },
  deleteProperty(target, key) {
    const res = Reflect.deleteProperty(target, key)
    console.log(`删除${key.toString()}: ${res}`)
    return res
  }
}
// vue-next/packages/reactivity/src/reactive.ts
function reactive(obj) {
  // reactive() 只接受非 null 的 object
  if (!isObject(obj)) {
    return obj
  }

  const observed = new Proxy(obj, baseHandler)
  return observed
}

// vue-next/packages/reactivity/src/effect.ts
function effect(fn, options = {}) {
  // 创建 reactiveEffect
  const effectRun = createReactiveEffect(fn, options)
  // 执行一次触发依赖收集
  effectRun()
  return effectRun
}
function createReactiveEffect(fn, options) {
  // 封装一个高阶函数，除了执行fn，还要将自己放入 effectStack 为依赖收集做准备
  const effect = function reactiveEffect(...args) {
    if (!effectStack.includes(effect)) {
      try {
        // 1、effect入栈
        effectStack.push(effect)
        // 2、执行fn
        return fn(...args)
      } finally {
        // 3、effect出栈
        effectStack.pop()
      }
    }
  }
  return effect
}

// vue-next/packages/reactivity/src/effect.ts
function track(target, key) {
  // 获取响应式函数
  const effect = effectStack[effectStack.length - 1]
  if (effect) {
    // 获取 target 映射关系 map，不存在则创建
    let depMap = targetMap.get(target)
    if (!depMap) {
      depMap = new Map()
      targetMap.set(target, depMap)
    }
    // 获取 key 对应依赖集合，不存在则创建
    let deps = depMap.get(key)
    if (!deps) {
      deps = new Set()
      depMap.set(key, deps)
    }
    // 将响应函数添加到依赖集合
    deps.add(effect)
  }
}

// vue-next/packages/reactivity/src/effect.ts
function trigger(target, key) {
  // 获取 target 对应依赖 map
  const depMap = targetMap.get(target)
  if (!depMap) return

  // 获取 key 对应集合
  const deps = depMap.get(key)

  if (deps) {
    // 将普通 effect 和 computed 区分开
    const effects = new Set()
    const computedRunners = new Set()
    // 执行所有响应函数
    deps.forEach(dep => {
      if (dep.computed) {
        computedRunners.add(dep)
      } else {
        effects.add(dep)
      }
    })
    computedRunners.forEach(computed => computed())
    effects.forEach(effect => effect())
  }
}

// vue-next/packages/reactivity/src/computed.ts
// 传入 fn 使之成为响应式函数，fn 内部依赖的数值发生变化，该函数应该重新执行获得最新的计算结果
function computed(fn) {
  // 创建一个特殊的 effect：
  // 这个effect创建时不会立刻执行，且会在其他effect后面执行
  const runner = effect(fn, {
    computed: true,
    lazy: true
  })
  // 返回一个对象包含响应函数和最新值的getter
  // 这样computed首次获取值时才收集依赖
  return {
    effect: runner,
    get value() {
      return runner()
    }
  }
}