---
title: Vue3 watchEffect 用法与实现原理
description: 从日常用法、调度时机、清理机制到 Vue 3 源码，循序渐进拆解 watchEffect 的自动依赖收集与重新执行机制。
publishDate: 2026-04-28 08:34:00
tags: ['Vue', 'watchEffect', '响应式', '源码分析']
heroImage:
  src: './thumbnail.jpg'
  alt: 'thumbnail.jpg'
  color: '#b2a33f'
language: 'zh'
draft: false
comment: true
---

# Vue3 watchEffect 用法与实现原理

在 Vue 3 的 Composition API 中，`watchEffect` 是一个很容易上手、但内部机制非常值得细读的 API。它的使用体验像是“把副作用函数丢给 Vue，Vue 自动知道它依赖了哪些响应式数据”，但这句话背后其实串起了 Vue 3 响应式系统里几个核心部件：

- `ReactiveEffect`：把一段函数包装成可追踪、可停止、可调度的响应式副作用。
- `track` / `trigger`：在读取时收集依赖，在写入时触发依赖。
- scheduler：控制副作用重新执行的时机，避免同步多次变更导致重复执行。
- cleanup：在副作用失效前清理上一次副作用留下的异步请求、定时器或订阅。

本文基于 [vuejs/core](https://github.com/vuejs/core) 的当前 `main` 分支，围绕 `packages/runtime-core/src/apiWatch.ts`、`packages/reactivity/src/watch.ts`、`packages/reactivity/src/effect.ts`、`packages/reactivity/src/dep.ts` 等源码，由浅入深分析 `watchEffect` 的用法和实现原理，并横向对比 React、Solid、Svelte 等框架里的类似能力。

## 1. 先从使用场景看 watchEffect

`watchEffect` 的类型大致如下：

```ts
function watchEffect(
  effect: (onCleanup: (cleanupFn: () => void) => void) => void,
  options?: {
    flush?: 'pre' | 'post' | 'sync'
    onTrack?: (event: DebuggerEvent) => void
    onTrigger?: (event: DebuggerEvent) => void
  }
): WatchHandle
```

它会立即执行传入的函数，并在函数同步执行期间自动收集读到的响应式依赖；这些依赖后续发生变化时，函数会再次执行。

```ts
import { ref, watchEffect } from 'vue'

const count = ref(0)

const stop = watchEffect(() => {
  console.log('count changed:', count.value)
})

count.value++

stop()
```

这段代码里没有显式告诉 Vue “我要监听 `count`”，但 `console.log` 读取了 `count.value`，所以 `count` 会被自动记录为依赖。

### 1.1 适合用 watchEffect 的场景

`watchEffect` 更适合“副作用依赖和副作用逻辑天然写在一起”的场景：

```ts
const todoId = ref(1)
const todo = ref(null)

watchEffect(async (onCleanup) => {
  const controller = new AbortController()

  onCleanup(() => {
    controller.abort()
  })

  const res = await fetch(`/api/todos/${todoId.value}`, {
    signal: controller.signal
  })
  todo.value = await res.json()
})
```

相比下面的 `watch`，`watchEffect` 少维护了一份 source：

```ts
watch(
  todoId,
  async (id, _oldId, onCleanup) => {
    const controller = new AbortController()

    onCleanup(() => {
      controller.abort()
    })

    const res = await fetch(`/api/todos/${id}`, {
      signal: controller.signal
    })
    todo.value = await res.json()
  },
  { immediate: true }
)
```

当副作用内部会读取多个响应式字段，或者读取的是深层对象中的少量字段时，`watchEffect` 通常比 `deep: true` 更经济：它只追踪实际读到的属性，而不是递归遍历整个对象。

### 1.2 不适合用 watchEffect 的场景

`watchEffect` 的代价是依赖不够显式，所以以下场景更适合 `watch`：

- 需要精确控制“哪个 source 变化才触发副作用”。
- 需要拿到 `newValue` 和 `oldValue`。
- 副作用里会读取一些“不应该触发重新执行”的响应式状态。
- 依赖关系复杂到需要让读者一眼看出触发来源。

可以简单记：

| API           | 依赖来源         | 首次执行   | 是否能拿旧值 | 适合场景                           |
| ------------- | ---------------- | ---------- | ------------ | ---------------------------------- |
| `watchEffect` | 自动收集同步读取 | 立即执行   | 否           | 自动请求、同步外部系统、调试依赖   |
| `watch`       | 显式 source      | 默认懒执行 | 是           | 精准监听、比较新旧值、控制触发条件 |

## 2. 两个容易踩坑的语义

### 2.1 只追踪同步阶段读到的依赖

Vue 官方文档特别强调：`watchEffect` 使用异步回调时，只会追踪第一个 `await` 之前同步读到的依赖。

```ts
watchEffect(async () => {
  console.log(id.value) // 会被追踪

  await fetch('/api/profile')

  console.log(token.value) // 不会被这次 watchEffect 自动追踪
})
```

原因后面看源码会很清楚：Vue 只能在 `ReactiveEffect.run()` 执行期间设置“当前正在收集依赖的 effect”。一旦同步调用栈结束，当前 effect 会被恢复，`await` 后面的代码已经不在这次依赖收集上下文里。

### 2.2 cleanup 要在副作用失效前执行

`watchEffect` 的 `onCleanup` 用来处理“上一次副作用已经过期”的情况：

```ts
watchEffect((onCleanup) => {
  const timer = window.setInterval(() => {
    console.log(count.value)
  }, 1000)

  onCleanup(() => {
    window.clearInterval(timer)
  })
})
```

当依赖变化导致 effect 重新执行，或者手动 `stop()` 时，Vue 会先执行上一次注册的 cleanup，再运行下一轮 effect。Vue 3.5+ 还提供了 `onWatcherCleanup`，可以在 `watch` / `watchEffect` 同步执行阶段直接注册清理函数。

## 3. 从入口看：watchEffect 只是 doWatch 的特殊分支

`watchEffect` 的运行时入口在 `packages/runtime-core/src/apiWatch.ts`：

```ts
export function watchEffect(effect: WatchEffect, options?: WatchEffectOptions): WatchHandle {
  return doWatch(effect, null, options)
}
```

这里最关键的是第二个参数传了 `null`。同一个 `doWatch` 同时承载了 `watch` 和 `watchEffect`：

- `watch(source, cb, options)`：有 `cb`，source 和副作用分离。
- `watchEffect(effect, options)`：没有 `cb`，传入的函数本身就是副作用。

`doWatch` 会处理运行时层面的能力，比如组件实例、错误处理、SSR、调度时机：

```ts
const runsImmediately = (cb && immediate) || (!cb && flush !== 'post')

if (flush === 'post') {
  baseWatchOptions.scheduler = (job) => {
    queuePostRenderEffect(job, instance && instance.suspense)
  }
} else if (flush !== 'sync') {
  baseWatchOptions.scheduler = (job, isFirstRun) => {
    if (isFirstRun) {
      job()
    } else {
      queueJob(job)
    }
  }
}

const watchHandle = baseWatch(source, cb, baseWatchOptions)
```

默认 `flush` 是 `'pre'`，所以 `watchEffect` 会立即执行第一次；依赖变化后的重新执行会进入调度队列。`flush: 'post'` 会放到组件渲染之后，`flush: 'sync'` 则不走异步队列，依赖一变就同步执行。

## 4. reactivity 层：把函数变成 ReactiveEffect

`doWatch` 最终调用的是 `@vue/reactivity` 包里的 `watch`。当它发现 `source` 是函数且没有 `cb` 时，会进入 `watchEffect` 分支：

```ts
if (isFunction(source)) {
  if (cb) {
    getter = call ? () => call(source, WatchErrorCodes.WATCH_GETTER) : source
  } else {
    getter = () => {
      if (cleanup) {
        pauseTracking()
        try {
          cleanup()
        } finally {
          resetTracking()
        }
      }

      const currentEffect = activeWatcher
      activeWatcher = effect
      try {
        return call
          ? call(source, WatchErrorCodes.WATCH_CALLBACK, [boundCleanup])
          : source(boundCleanup)
      } finally {
        activeWatcher = currentEffect
      }
    }
  }
}
```

这一段做了三件事：

1. 每次重新运行 effect 前，先执行上一次注册的 `cleanup`。
2. 临时设置 `activeWatcher = effect`，让 `onWatcherCleanup` 知道当前属于哪个 watcher。
3. 执行用户传入的 `source(boundCleanup)`，也就是我们的 `watchEffect` 回调。

接着 Vue 创建真正的响应式副作用对象：

```ts
effect = new ReactiveEffect(getter)

effect.scheduler = scheduler ? () => scheduler(job, false) : job

boundCleanup = (fn) => onWatcherCleanup(fn, false, effect)
```

可以把 `watchEffect` 理解成：

> 用 `ReactiveEffect` 包装用户函数；执行时自动收集依赖；依赖触发时，不直接运行用户函数，而是交给 scheduler 决定何时运行。

## 5. 自动依赖收集：为什么读 count.value 就会被记录

以 `ref` 为例，`count.value` 的 getter 会调用 `dep.track()`：

```ts
get value() {
  this.dep.track()
  return this._value
}
```

`reactive` 对象也类似，Proxy 的 `get` 拦截里会调用 `track(target, TrackOpTypes.GET, key)`。

真正的依赖关系存储在 `packages/reactivity/src/dep.ts`。Vue 3 当前实现使用 `WeakMap -> Map -> Dep` 找到某个对象某个 key 对应的依赖集合：

```ts
export const targetMap: WeakMap<object, KeyToDepMap> = new WeakMap()

export function track(target: object, type: TrackOpTypes, key: unknown): void {
  if (shouldTrack && activeSub) {
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      targetMap.set(target, (depsMap = new Map()))
    }

    let dep = depsMap.get(key)
    if (!dep) {
      depsMap.set(key, (dep = new Dep()))
    }

    dep.track()
  }
}
```

这里的 `activeSub` 就是当前正在执行的 `ReactiveEffect`。而 `activeSub` 是在 `ReactiveEffect.run()` 中设置的：

```ts
run(): T {
  this.flags |= EffectFlags.RUNNING
  cleanupEffect(this)
  prepareDeps(this)

  const prevEffect = activeSub
  const prevShouldTrack = shouldTrack
  activeSub = this
  shouldTrack = true

  try {
    return this.fn()
  } finally {
    cleanupDeps(this)
    activeSub = prevEffect
    shouldTrack = prevShouldTrack
    this.flags &= ~EffectFlags.RUNNING
  }
}
```

因此 `watchEffect(() => count.value)` 的完整链路是：

1. `watchEffect` 创建 `ReactiveEffect(getter)`。
2. 初次运行 `effect.run()`。
3. `ReactiveEffect.run()` 把 `activeSub` 设置为当前 effect。
4. 用户函数读取 `count.value`。
5. `ref.value` getter 调用 `dep.track()`。
6. `dep.track()` 发现当前有 `activeSub`，于是把 `count.value` 对应的 `Dep` 和当前 effect 建立订阅关系。
7. 执行结束后恢复上一个 `activeSub`，清理本轮没再用到的旧依赖。

这就是“自动依赖收集”的本质：不是静态分析代码，也不是编译器猜测变量，而是在运行时通过 getter/Proxy 捕获真实读取行为。

## 6. 触发更新：写入 count.value 后发生了什么

`ref.value` 的 setter 会在值变化后调用 `dep.trigger()`：

```ts
set value(newValue) {
  if (hasChanged(newValue, oldValue)) {
    this._rawValue = newValue
    this._value = toReactive(newValue)
    this.dep.trigger()
  }
}
```

`reactive` 对象的 `set`、`deleteProperty`、集合操作也会走到 `trigger(...)`。触发时，Vue 会找到这个 key 关联的 `Dep`，再通知其中订阅的 effect：

```ts
trigger(debugInfo?: DebuggerEventExtraInfo): void {
  this.version++
  globalVersion++
  this.notify(debugInfo)
}

notify(debugInfo?: DebuggerEventExtraInfo): void {
  startBatch()
  try {
    for (let link = this.subs; link; link = link.prevSub) {
      link.sub.notify()
    }
  } finally {
    endBatch()
  }
}
```

`ReactiveEffect.notify()` 不会立刻执行用户函数，而是先进入批处理：

```ts
notify(): void {
  if (this.flags & EffectFlags.RUNNING && !(this.flags & EffectFlags.ALLOW_RECURSE)) {
    return
  }

  if (!(this.flags & EffectFlags.NOTIFIED)) {
    batch(this)
  }
}
```

批处理结束后，`ReactiveEffect.trigger()` 再根据是否有 scheduler 决定执行方式：

```ts
trigger(): void {
  if (this.flags & EffectFlags.PAUSED) {
    pausedQueueEffects.add(this)
  } else if (this.scheduler) {
    this.scheduler()
  } else {
    this.runIfDirty()
  }
}
```

这解释了两个现象：

- 同一个 tick 内多次同步修改同一个依赖，默认不会导致 `watchEffect` 重复无意义地执行很多次。
- `flush: 'sync'` 绕过调度队列，适合极少数需要同步失效的缓存场景，但不适合监听会被高频同步修改的数据结构。

## 7. flush 时机：pre、post、sync 的真正区别

`watchEffect` 的 `flush` 不是“是否执行”，而是“依赖变化后排到哪里执行”。

### 7.1 默认 pre：组件更新前

默认模式会在第一次运行时直接执行：

```ts
baseWatchOptions.scheduler = (job, isFirstRun) => {
  if (isFirstRun) {
    job()
  } else {
    queueJob(job)
  }
}
```

随后重新执行会进入 `queueJob`。`doWatch` 还会给 job 标记 `PRE`，并把组件实例 `uid` 设置为 job id：

```ts
if (isPre) {
  job.flags! |= SchedulerJobFlags.PRE
  if (instance) {
    job.id = instance.uid
    job.i = instance
  }
}
```

调度器会按 id 排序，保证父子组件和 pre watcher 的执行顺序稳定。默认 watcher 会在所属组件 DOM 更新前运行，所以不适合在里面读取更新后的 DOM。

### 7.2 post：组件更新后

如果需要访问更新后的 DOM，应使用：

```ts
watchEffect(
  () => {
    console.log(el.value?.offsetHeight)
  },
  { flush: 'post' }
)
```

或者语义更明确的别名：

```ts
watchPostEffect(() => {
  console.log(el.value?.offsetHeight)
})
```

源码里 `flush: 'post'` 会使用 `queuePostRenderEffect`，它会在渲染完成后执行。

### 7.3 sync：同步触发

`watchSyncEffect` 等价于 `watchEffect(..., { flush: 'sync' })`。它不进入 `queueJob`，依赖一变就同步触发：

```ts
watchSyncEffect(() => {
  cache.invalidate(key.value)
})
```

这个模式要谨慎使用。如果同步 push 一千次数组，普通 watcher 可以被批处理合并，sync watcher 则会更容易出现性能问题和中间状态问题。

## 8. cleanup、pause、resume、stop 如何工作

`watchEffect` 返回的是一个可调用的 handle：

```ts
const handle = watchEffect(() => {})

handle.pause()
handle.resume()
handle.stop()
handle() // 等价于 stop()
```

在 `@vue/reactivity` 的 `watch` 实现中：

```ts
const watchHandle: WatchHandle = () => {
  effect.stop()
  if (scope && scope.active) {
    remove(scope.effects, effect)
  }
}

watchHandle.pause = effect.pause.bind(effect)
watchHandle.resume = effect.resume.bind(effect)
watchHandle.stop = watchHandle
```

`stop()` 会断开当前 effect 和所有 dep 的订阅关系，并执行 `onStop`。`watchEffect` 注册的 cleanup 最终挂在 `effect.onStop` 上：

```ts
cleanup = effect.onStop = () => {
  const cleanups = cleanupMap.get(effect)
  if (cleanups) {
    for (const cleanup of cleanups) cleanup()
    cleanupMap.delete(effect)
  }
}
```

`pause()` / `resume()` 则通过 `EffectFlags.PAUSED` 控制触发行为：暂停期间依赖变化不会立即执行；恢复时如果暂停期间发生过触发，会补跑一次。

## 9. 和 computed 的区别

`watchEffect` 和 `computed` 都基于 `ReactiveEffect`，也都会自动收集依赖，但目的完全不同：

| 能力             | `computed`                   | `watchEffect`         |
| ---------------- | ---------------------------- | --------------------- |
| 目标             | 产生可缓存的派生值           | 执行副作用            |
| 是否应该有副作用 | 不应该                       | 本来就是副作用        |
| 返回值           | 一个 ref-like 结果           | 停止/暂停/恢复 handle |
| 执行策略         | 懒计算，读取 `.value` 时刷新 | 创建后立即执行        |
| 依赖变化后       | 标记 dirty，必要时重新计算   | 重新执行用户副作用    |

如果一段逻辑是“根据 A、B 算出 C”，优先用 `computed`；如果是“当 A、B 变化时请求接口、写日志、同步 DOM、订阅外部资源”，才考虑 `watchEffect`。

## 10. 横向对比其他框架

### 10.1 React useEffect：依赖数组是显式契约

React 的 `useEffect` 依赖数组是显式声明：

```tsx
useEffect(() => {
  document.title = `${count}`
}, [count])
```

React 不会在运行时追踪 `effect` 里读了哪些状态。依赖数组写少了会产生闭包陈旧问题，写多了可能导致不必要执行，所以 React 社区需要 `eslint-plugin-react-hooks` 帮助检查依赖。

Vue 的 `watchEffect` 则更像运行时依赖追踪：读取了什么，就订阅什么。好处是少写依赖数组，坏处是依赖隐藏在函数体内部，复杂副作用的触发来源不如 `watch` 或 React 依赖数组直观。

### 10.2 Solid createEffect：同样自动追踪，但粒度更细

Solid 的 `createEffect` 和 Vue 的 `watchEffect` 在心智模型上更接近：

```ts
createEffect(() => {
  console.log(count())
})
```

它也通过运行时读取 signal 来自动建立依赖。不过 Solid 的渲染模型本身就是细粒度响应式，组件函数不是像 React 那样反复整体执行；Vue 则把细粒度响应式和组件级渲染 effect 结合起来，通过 scheduler 协调 watcher、组件更新和 post flush callback。

### 10.3 Svelte $effect：编译器参与更多

Svelte 5 的 `$effect` 也可以写出类似自动依赖的副作用：

```ts
$effect(() => {
  console.log(count)
})
```

Svelte 的特色是编译器参与度更高，会把组件代码编译成更直接的更新逻辑。Vue 3 则主要依靠运行时 Proxy/ref 追踪，在无需编译器特殊语法的情况下，让普通 JavaScript 访问也能参与响应式。

## 11. 用一段伪代码总结 watchEffect

把细节压缩后，`watchEffect` 大致可以看成：

```ts
function watchEffect(userEffect, options) {
  let cleanup

  const getter = () => {
    if (cleanup) cleanup()

    userEffect((fn) => {
      cleanup = fn
    })
  }

  const effect = new ReactiveEffect(getter)

  effect.scheduler = createScheduler(options.flush)

  effect.run()

  return () => effect.stop()
}
```

`ReactiveEffect.run()` 内部再做：

```ts
function run() {
  activeSub = currentEffect
  try {
    getter()
  } finally {
    activeSub = previousEffect
  }
}
```

响应式读取时：

```ts
function track(target, key) {
  if (activeSub) {
    deps[target][key].add(activeSub)
  }
}
```

响应式写入时：

```ts
function trigger(target, key) {
  for (const effect of deps[target][key]) {
    effect.scheduler ? effect.scheduler() : effect.run()
  }
}
```

真实 Vue 源码比这复杂得多：它要处理嵌套 effect、依赖清理、批处理、组件更新顺序、递归保护、调试钩子、SSR、effect scope、暂停恢复等。但核心闭环始终是这四步：

> 运行 effect -> 读取时 track -> 写入时 trigger -> scheduler 决定何时重新运行 effect。

## 12. 实战建议

最后给出一些使用建议：

1. **优先保持副作用小而清晰**：`watchEffect` 里读取的响应式数据越多，触发来源越隐蔽。
2. **异步请求一定考虑 cleanup**：避免旧请求晚返回后覆盖新状态。
3. **需要旧值就用 watch**：不要在 `watchEffect` 里手写额外变量模拟 `oldValue`，可读性通常更差。
4. **读 DOM 用 post**：需要访问组件更新后的 DOM 时使用 `flush: 'post'` 或 `watchPostEffect`。
5. **谨慎使用 sync**：只有缓存失效这类非常明确的同步场景才考虑 `watchSyncEffect`。
6. **复杂场景用 onTrack/onTrigger 调试**：它们可以告诉你 effect 追踪了什么、被什么触发。

## 结语

`watchEffect` 的 API 很简单，但它正好站在 Vue 3 响应式系统和运行时调度系统的交界处。理解它，可以顺着一条很清晰的线索看懂 Vue 3 的响应式核心：`ReactiveEffect` 负责描述“谁依赖谁”，`track` / `trigger` 负责建立和触发依赖关系，scheduler 负责把重新执行安排在正确的时机，cleanup 负责让副作用具备失效语义。

当你只是想“依赖什么就自动重新做什么”时，`watchEffect` 很顺手；当你需要更强的边界、更明确的触发条件和新旧值时，`watch` 仍然是更合适的工具。理解二者背后的实现差异，才能在业务代码里做出更稳定的选择。
