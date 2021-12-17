---
theme: juejin
---
# vue3 数据响应式原理

其实拿到一个题目（问题），我一般的思考方式分为三步，是什么？为什么？怎么办？
记得这是学生时代某个老师教的答题提纲，按照这个方式答题，一目了然，必然高分，😄 ！我按照此方法多次答题，百试不爽。

那接下来就按照这个步骤走起...

## What

### 什么是数据响应式？

一句话说就是：数据变化可侦测，和数据相关的内容可以更新。

Vue2 利用：[Object.defineProperty()](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Object/defineProperty) 方法会直接在一个对象上定义一个新属性，或者修改一个对象的现有属性，并返回此对象。

也就是对属性的读取、修改进行拦截（数据劫持）

```js
// 拦截每个key，从而可以侦测数据变化
function defineReactive(obj, key, val) {
  Object.defineProperty(obj, key, {
    enumerable: true,  // 该属性才会出现在对象的枚举属性中
    configurable: true, // 该属性的描述符才能够被改变，同时该属性也能从对应的对象上被删除
    get() {
      console.log("get", key);
      return val
    },
    set(newVal) {
      if (newVal !== val) {
        console.log("set", key);
        val = newVal;
        update()
      }
    }
  })
}
function update() {
  console.log(obj.a);
}

// test
const obj = {}
defineReactive(obj, 'a', '前端')
obj.a = '后端'
```

Vue3 利用：[Proxy](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy) 对象用于创建一个对象的代理，从而实现基本操作的拦截和自定义（如属性查找、赋值、枚举、函数调用等）。

也就是拦截对象中任意属性的变化，包括：属性值的读写、属性的添加、属性的删除等。直接监听对象而非属性。

```js
// 代理整个对象，从而侦测数据变化
function defineReactive(obj) {
  return new Proxy(obj, {
    get(target, key) {
      console.log("get", key);
      return target[key]    
    },
    set(target, key, val) {
      console.log("set", key);
      target[key] =val
      update()    
    }  
  })
}
function update() {
  console.log(obj.a);
}

// test
const obj= {}
const observed = defineReactive(obj)
observed.a='前端'
```

可以看出，proxy 不需要关心具体的 key，它去拦截的是 修改 data 上的任意 key 和 读取 data 上的任意 key。

所以，不管是已有的 key 还是新增的 key，都会监听到。

但是 Proxy 更加强大的地方还在于 Proxy 除了 get 和 set，还可以拦截更多的操作符，具体可看 MDN。

## Why

### Vue2 的缺点

1、Vue2 需要遍历对象所有 key，这会影响初始化速度。

```js
// 遍历响应式处理
function observe(obj) {
  if (typeof obj !== "object" || obj === null) {
    return obj;
  }

  Object.keys(obj).forEach((key) => defineReactive(obj, key, obj[key]));
}
```

在 Vue2 中，对于一个深层属性嵌套的对象，要劫持它内部深层次的变化，就需要递归遍历这个对象，执行 Object.defineProperty 把每一层对象数据都变成响应式的，这无疑会有很大的性能消耗。

2、Vue2 对于数组要做特殊处理，修改数据时也不能使用索引方式。

```js
// 数组响应式
// 1、替换数组原型中的 7个方法
const originalProto = Array.prototype
// 备份一份，修改备份
const arrayProto = Object.create(originalProto);
['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse'].forEach(method => {
  arrayProto[method] = function () {
    // 原始操作
    originalProto[method].apply(this, arguments)
    // 覆盖操作，通知更新
    console.log('数组执行' + method + '操作')
  }
})
```

3、Vue2 中动态添加或删除对象属性需要使用额外API：Vue.set()/delete()

```js
Vue.set(obj, 'a', '前端')
Vue.delete(obj, 'a')
```

4、Vue2 不支持Map、Set、Class等数据结构

小结：defineProperty API 的局限性最大原因是**它只能针对单例属性做监听**。

-   Vue2 中的响应式实现正是基于defineProperty 中的 descriptor，对 data 中的属性做了遍历 + 递归，为每个属性设置了 getter、setter。
-   这也就是为什么 Vue2 只能对 data 中预定义过的属性做出响应的原因，在 Vue2 中使用下标的方式直接修改属性的值或者添加一个预先不存在的对象属性是无法做到 setter 监听的，这是 defineProperty 的局限性。

而 Vue3 中利用 Proxy 可以很好的解决以上的问题。

## How

### 源码分析

1、目标对象 target `vue-next/packages/reactivity/src/reactive.ts`

2、reactive() `vue-next/packages/reactivity/src/reactive.ts`

3、createReactiveObject() `vue-next/packages/reactivity/src/reactive.ts`

4、mutableHandlers `vue-next/packages/reactivity/src/baseHandlers.ts`

5、get => createGetter() `vue-next/packages/reactivity/src/baseHandlers.ts`

6、set => createSetter() `vue-next/packages/reactivity/src/baseHandlers.ts`

7、effect() `vue-next/packages/reactivity/src/effect.ts`

8、ReactiveEffect `vue-next/packages/reactivity/src/effect.ts`

9、track() `vue-next/packages/reactivity/src/effect.ts`

10、trackEffects() `vue-next/packages/reactivity/src/effect.ts`

11、trigger() `vue-next/packages/reactivity/src/effect.ts`

12、triggerEffects() `vue-next/packages/reactivity/src/effect.ts`

在此，顺带聊一下 [阅读源码的意义与方法](https://juejin.cn/post/6844903501953253384)


### Vue3 中的响应式简易实现

让我们先来大概了解一下 Vue3 的响应式：

```js
function reactive(obj) {
  if (typeof obj !== 'object' && obj !== null) {
    return obj
  }
  // Proxy 相当于在对象外层加拦截
  const observed = new Proxy(obj, {
    get(target, key, receiver) {
      // Reflect 用于执行对象默认操作，更规范、更友好
      // 对反射机制的实现，通过反射可以让程序在运行时能够获取自身的某些信息
      // Proxy 和 Object 的方法 Reflect 都有对应
      // https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Reflect
      const res = Reflect.get(target, key, receiver)
      console.log(`获取${key}: ${res}`)
      return res
    },
    set(target, key, value, receiver) {
      const res = Reflect.set(target, key, value, receiver)
      console.log(`设置${key}: ${value}`)
      return res
    },
    deleteProperty(target, key) {
      const res = Reflect.deleteProperty(target, key)
      console.log(`删除${key}: ${res}`)
      return res
    }
  })
  return observed
}

// 测试
const state = reactive({ a: '前端' })
// 获取
state.a
// 设置已存在属性
state.a = '后端'
// 设置不存在属性
state.b = '运维'
// 删除属性
delete state.b
```

Reflect 只是能和 Proxy 搭配更好的完成了对象中数据的存取操作，而并不是实现的关键核心。

不过，还是了解一下，为什么用 Reflect.get() 和 Reflect.set()，而不是直接用 target[key]？

根据 [MDN 介绍 set() 要返回一个布尔值](https://developer.mozilla.org/zh-CN/docs/Web/JavaScript/Reference/Global_Objects/Proxy/Proxy/set)，比如 Reflect.set() 会返回一个是否修改成功的布尔值，直接赋值 `target[key] = newValue`，而不返回 true 就会报错。而且不管 Proxy 怎么修改默认行为，都可以通过 Reflect 获取默认行为。get() 同理。

vue3 的响应式核心原理即是通过 Proxy 代理目标对象的存取器，拦截存取操作，在执行收集依赖 track 以及触发更新 trigger 的方法后再完成原先的存取操作。

Proxy API 的监听是针对一个对象的，那么对这个对象的所有操作会进入监听操作， 这就完全可以代理所有属性，将会带来很大的性能提升和更优的代码。

-   Proxy 可以理解成，在目标对象之前架设一层“拦截”，外界对该对象的访问，都必须先通过这层拦截，因此提供了一种机制，可以对外界的访问进行过滤和改写。

上面代码对嵌套对象没有做处理，需要递归处理。

```js
// 传入对象应该是一个非 null 的 object
const isObject = obj => typeof obj === 'object' && obj !== null

// vue-next/packages/reactivity/src/baseHandlers.ts
const baseHandler = {
  get(target, key, receiver) {
    let res = Reflect.get(target, key, receiver)
    // 判断 res 是对象，递归处理它
    res = isObject(res) ? reactive(res) : res
    console.log(`获取${key.toString()}: ${res}`)
    return res
  },
  set(target, key, value, receiver) {
    const res = Reflect.set(target, key, value, receiver)
    console.log(`设置${key.toString()}: ${value}`)
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

// 测试
const state = reactive({ a: '前端' })
// 获取
state.a
// 设置已存在属性
state.a = '后端'
// 设置不存在属性
state.b = '运维'
// 删除属性
delete state.b

// 测试2
const state2 = reactive({
  c: { d: '算法' }
})
// 获取
state2.c.d
// 设置已存在属性
state2.c.d = '产品'
// 设置不存在属性
state2.c.e = '设计'
// 删除属性
delete state2.c.e
```

在 Vue3 中使用 Proxy API 并不能监听到对象内部深层次的属性变化，因此它的处理方式是在 getter 中去递归响应式，这样的好处是真正访问到的内部属性才会变成响应式，简单的可以说是按需实现响应式，减少性能消耗。

响应式实现的基本结构：

```js
// 临时存储响应式函数
const effectStack = []

// 传入 fn，返回的函数将是响应式的，内部代理的数据发生变化，它会再次执行
function effect(fn, options = {}) { }

// 存放响应式函数和目标、键之间的映射关系
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/WeakMap
const targetMap = new WeakMap()

// 依赖收集，建立响应式函数与其访问的目标(target)和键(key)之间的映射关系
function track(target, key) { }

// 根据 track() 建立的映射关系，找到对应响应式函数并执行它
function trigger(target, key) { }
```

* 数据响应式：reactive()
* 添加副作用：effect()
* 依赖收集：track()
* 触发响应：trigger()

```js
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
```

```html
<div id="app"></div>

<script src="demo.js"></script>

<script>
  const obj = {
    name: '前端',
    num: 1,
    action: '学呀',
    emo: '😭'
  }

  const data = reactive(obj)

  const app = document.getElementById('app')

  const myAction = computed(() => {
    data.action = ''
    for (let i = 0; i < data.num; i++) {
      data.action += `学呀 `
    }
    return data.action
  })

  const myEmo = computed(() => {
    data.emo = ''
    for (let i = 0; i < data.num; i++) {
      data.emo += `😭 `
    }
    return data.emo
  })

  // effect() 定义我们的更新函数
  effect(() => {
    console.log(myAction)
    app.innerHTML = `<h1>${data.name}主流框架现有${data.num}个</h1>
    <h2>我们就要不停的${myAction.value}!</h2>
    <h3>${myEmo.value}</h3>`
  })

  // 修改一下数值
  const timerId = setInterval(() => {
    data.num++
    if (data.num > 8) clearInterval(timerId)
  }, 5000);
</script>
```
