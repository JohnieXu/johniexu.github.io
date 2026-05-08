---
title: 聊一聊 qiankun 主子应用通信、状态与缓存方案
description: 从 props、globalState、应用生命周期到缓存保活，梳理 qiankun 微前端项目里主子应用通信与状态管理的落地方案。
publishDate: 2026-05-06 23:31:00
tags: ['qiankun', 'micro-frontend', 'vue', 'react', '工程实践']
heroImage:
  src: './thumbnail.jpg'
  alt: 'thumbnail.jpg'
  color: '#669933'
language: 'zh'
draft: false
comment: true
---

# 聊一聊 qiankun 主子应用通信、状态与缓存方案

最近重新梳理了一遍 qiankun 项目里的主子应用通信问题，发现很多争论其实不是 API 不够用，而是没有先把“要通信的东西”分清楚。

微前端项目里经常会把这些事情都叫通信：

- 主应用把登录态、菜单、主题、语言传给子应用。
- 子应用告诉主应用“我需要跳转”、“我保存成功了”、“请刷新角标”。
- 主应用需要知道某个子应用现在是 loading、mounted 还是 load error。
- 用户切走再切回来时，希望列表筛选条件、滚动位置、甚至组件实例都还在。

这些场景放到一起看很乱，拆开之后会清楚很多。本文基于 qiankun 2.x 的公开 API 和一些项目实践，聊一下主子应用通信、数据边界、应用实例状态，以及最后最容易踩坑的缓存/保活问题。

> qiankun 官方 API 可参考：[API 说明](https://qiankun.umijs.org/zh/api)。本文重点不复述文档，而是讨论工程里怎么组合使用。

## 1. 先给通信做分类

我一般把 qiankun 的通信分成四类：

| 类型 | 典型内容 | 推荐方案 |
| --- | --- | --- |
| 初始化配置 | token、用户信息、主题、语言、主应用能力函数 | `props` |
| 全局轻状态 | 登录态变化、主题变化、权限版本号 | `initGlobalState` |
| 一次性事件 | 刷新某个列表、打开主应用弹窗、跨应用跳转 | 主应用注入 event bus 或命令函数 |
| 可持久业务数据 | 表格数据、表单草稿、详情页缓存 | 子应用自己的数据层或后端接口 |

这张表的关键点是：不要把所有数据都塞进 qiankun 的 globalState。

globalState 适合放“少量、结构稳定、全局共享”的状态。它不是 Redux，也不是 Pinia，更不是一个跨应用数据库。复杂业务数据最好仍然留在子应用自己的数据层里，或者通过后端接口保持一致。

## 2. props：最朴素，也最稳定

`registerMicroApps` 和 `loadMicroApp` 都支持给子应用传 `props`。这类数据会在子应用生命周期函数里拿到。

主应用：

```ts
// src/micro/apps.ts
import { registerMicroApps, start } from 'qiankun'

registerMicroApps([
  {
    name: 'order-app',
    entry: '//localhost:7101',
    container: '#micro-container',
    activeRule: '/order',
    props: {
      basename: '/order',
      getToken: () => localStorage.getItem('token'),
      navigateTo: (url: string) => window.history.pushState(null, '', url)
    }
  }
])

start({
  sandbox: {
    experimentalStyleIsolation: true
  },
  prefetch: 'all'
})
```

子应用：

```ts
// src/main.tsx
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import App from './App'

type MicroProps = {
  container?: HTMLElement
  basename?: string
  getToken?: () => string | null
  navigateTo?: (url: string) => void
}

let root: Root | null = null

function render(props: MicroProps = {}) {
  const container = props.container
    ? props.container.querySelector('#root')
    : document.querySelector('#root')

  if (!container) return

  root = createRoot(container)
  root.render(
    <App
      basename={props.basename ?? '/'}
      getToken={props.getToken}
      navigateTo={props.navigateTo}
    />
  )
}

if (!window.__POWERED_BY_QIANKUN__) {
  render()
}

export async function mount(props: MicroProps) {
  render(props)
}

export async function unmount() {
  root?.unmount()
  root = null
}
```

这种方式的优点是边界清楚：主应用只提供能力，不关心子应用内部实现。比如 `navigateTo` 是“命令”，子应用不需要知道主应用用的是 react-router、vue-router 还是原生 history。

需要注意的是，`props` 更适合传稳定能力和初始化参数。如果 token、主题这类数据会频繁变化，就不要只依赖第一次 mount 时传入的值，可以配合 `update` 或 globalState。

## 3. globalState：适合做全局轻状态

qiankun 提供了 `initGlobalState`：

- `onGlobalStateChange`：监听全局状态变化。
- `setGlobalState`：更新全局状态。
- `offGlobalStateChange`：移除监听。

官方文档里有一个细节很容易忽略：微应用只能修改初始化时已经存在的一级属性。也就是说，主应用一开始就要把状态结构设计好，不要运行时随意加字段。

主应用可以先做一层封装：

```ts
// src/micro/global-state.ts
import { initGlobalState, type MicroAppStateActions } from 'qiankun'

export type ThemeMode = 'light' | 'dark'

export type MicroGlobalState = {
  token: string
  user: {
    id: string
    name: string
    roles: string[]
  } | null
  theme: ThemeMode
  locale: 'zh-CN' | 'en-US'
  authVersion: number
}

const initialState: MicroGlobalState = {
  token: '',
  user: null,
  theme: 'light',
  locale: 'zh-CN',
  authVersion: 0
}

export const microActions: MicroAppStateActions =
  initGlobalState(initialState)

microActions.onGlobalStateChange((state, prev) => {
  if (state.token !== prev.token) {
    console.log('[micro-state] token changed')
  }
})

export function patchMicroState(state: Partial<MicroGlobalState>) {
  microActions.setGlobalState(state)
}
```

注册子应用时把 actions 透传下去：

```ts
// src/micro/apps.ts
import { registerMicroApps } from 'qiankun'
import { microActions } from './global-state'

registerMicroApps([
  {
    name: 'order-app',
    entry: '//localhost:7101',
    container: '#micro-container',
    activeRule: '/order',
    props: {
      ...microActions
    }
  }
])
```

子应用使用：

```ts
type MicroProps = {
  onGlobalStateChange?: (
    callback: (state: MicroGlobalState, prev: MicroGlobalState) => void,
    fireImmediately?: boolean
  ) => void
  setGlobalState?: (state: Partial<MicroGlobalState>) => boolean
  offGlobalStateChange?: () => boolean
}

let offBus: Array<() => void> = []

export async function mount(props: MicroProps) {
  props.onGlobalStateChange?.((state, prev) => {
    if (state.theme !== prev.theme) {
      document.documentElement.dataset.theme = state.theme
    }

    if (state.authVersion !== prev.authVersion) {
      // 权限版本变化，子应用按需重新拉菜单或清理本地权限缓存
      reloadPermission()
    }
  }, true)

  render(props)
}

export async function unmount(props: MicroProps) {
  props.offGlobalStateChange?.()
  offBus.forEach((off) => off())
  offBus = []
  destroyApp()
}
```

这里有两个实践经验：

1. globalState 中尽量放“值”，不要放复杂对象实例。函数、路由实例、store 实例更适合通过 props 注入。
2. globalState 里可以放 `authVersion`、`menuVersion` 这种版本号。主应用更新权限之后只递增版本，子应用自己决定怎么清缓存和重新请求。

## 4. 一次性事件：封装一个主应用 event bus

有些场景不适合用 globalState，比如：

- 子应用保存订单成功后，通知主应用刷新待办角标。
- 主应用点击全局刷新按钮，通知当前子应用重新拉列表。
- 子应用请求主应用打开一个全局抽屉。

这些都是事件，不是状态。用 globalState 做事件会产生很多奇怪字段，比如 `refreshOrderListAt: Date.now()`，能用，但读起来很别扭。

可以在主应用封装一个很小的 event bus，再通过 props 注入给子应用：

```ts
// src/micro/event-bus.ts
type Handler<T = unknown> = (payload: T) => void

export function createEventBus() {
  const events = new Map<string, Set<Handler>>()

  return {
    on<T>(type: string, handler: Handler<T>) {
      const handlers = events.get(type) ?? new Set()
      handlers.add(handler as Handler)
      events.set(type, handlers)

      return () => {
        handlers.delete(handler as Handler)
        if (handlers.size === 0) {
          events.delete(type)
        }
      }
    },

    emit<T>(type: string, payload: T) {
      events.get(type)?.forEach((handler) => handler(payload))
    },

    clear(type?: string) {
      if (type) {
        events.delete(type)
      } else {
        events.clear()
      }
    }
  }
}

export const microEventBus = createEventBus()
```

主应用注入：

```ts
import { microEventBus } from './event-bus'

const commonProps = {
  eventBus: microEventBus,
  navigateTo: (url: string) => window.history.pushState(null, '', url)
}
```

子应用监听时一定要保存取消订阅函数，并在 `unmount` 时释放：

```ts
type EventBus = {
  on<T>(type: string, handler: (payload: T) => void): () => void
  emit<T>(type: string, payload: T): void
}

type MicroProps = {
  eventBus?: EventBus
}

let disposers: Array<() => void> = []

export async function mount(props: MicroProps) {
  const offRefresh = props.eventBus?.on('order:refresh', () => {
    queryClient.invalidateQueries({ queryKey: ['orders'] })
  })

  if (offRefresh) {
    disposers.push(offRefresh)
  }

  render(props)
}

export async function unmount() {
  disposers.forEach((dispose) => dispose())
  disposers = []
  destroyApp()
}
```

如果两个子应用需要直接通信，我仍然建议先经过主应用。主应用至少能记录事件、做权限校验、做灰度兼容。子应用之间互相拿对方实例，短期省事，后面会很难拆。

## 5. 应用实例状态：不要只靠 loading

主应用经常需要知道子应用现在是什么状态：加载中、挂载完成、卸载中、加载失败。qiankun 有两条路：

1. 基于 `registerMicroApps` 的生命周期钩子维护状态。
2. 基于 `loadMicroApp` 返回的 `MicroApp` 实例调用 `getStatus()`。

### 5.1 路由托管场景：用生命周期维护状态表

```ts
// src/micro/status.ts
export type MicroStatus =
  | 'idle'
  | 'loading'
  | 'mounting'
  | 'mounted'
  | 'unmounting'
  | 'unmounted'
  | 'error'

const statusMap = new Map<string, MicroStatus>()

export function setMicroStatus(name: string, status: MicroStatus) {
  statusMap.set(name, status)
  window.dispatchEvent(
    new CustomEvent('micro-status-change', {
      detail: { name, status }
    })
  )
}

export function getMicroStatus(name: string) {
  return statusMap.get(name) ?? 'idle'
}
```

注册时统一接入：

```ts
import { addGlobalUncaughtErrorHandler, registerMicroApps } from 'qiankun'
import { setMicroStatus } from './status'

registerMicroApps(apps, {
  beforeLoad: (app) => {
    setMicroStatus(app.name, 'loading')
  },
  beforeMount: (app) => {
    setMicroStatus(app.name, 'mounting')
  },
  afterMount: (app) => {
    setMicroStatus(app.name, 'mounted')
  },
  beforeUnmount: (app) => {
    setMicroStatus(app.name, 'unmounting')
  },
  afterUnmount: (app) => {
    setMicroStatus(app.name, 'unmounted')
  }
})

addGlobalUncaughtErrorHandler((event) => {
  const appName = event?.appOrParcelName
  if (appName) {
    setMicroStatus(appName, 'error')
  }
})
```

这层状态表的作用不只是展示 loading，还可以服务于：

- 主应用菜单禁用重复点击。
- 失败时展示“重新加载子应用”。
- 埋点统计子应用加载耗时。
- 在主应用侧判断事件是否可以发送给某个子应用。

### 5.2 手动加载场景：保留 MicroApp 实例

`loadMicroApp` 会返回一个微应用实例，实例上有：

- `mount()`
- `unmount()`
- `update(customProps)`
- `getStatus()`
- `loadPromise`
- `mountPromise`
- `unmountPromise`

这类 API 更适合非路由驱动、一个页面同时加载多个微应用，或者需要主应用精细控制生命周期的场景。

```ts
import { loadMicroApp, type MicroApp } from 'qiankun'

type MicroRecord = {
  app: MicroApp
  container: HTMLElement
}

const microRecords = new Map<string, MicroRecord>()

export function mountWidgetApp(name: string, entry: string, props: object) {
  const cached = microRecords.get(name)

  if (cached) {
    const status = cached.app.getStatus()

    if (status === 'MOUNTED') {
      cached.app.update(props)
      return cached.app
    }
  }

  const container = document.createElement('div')
  container.id = `micro-widget-${name}`
  document.querySelector('#widget-container')?.appendChild(container)

  const app = loadMicroApp({
    name,
    entry,
    container,
    props
  })

  microRecords.set(name, { app, container })
  return app
}

export async function unmountWidgetApp(name: string) {
  const record = microRecords.get(name)
  if (!record) return

  await record.app.unmount()
  record.container.remove()
  microRecords.delete(name)
}
```

如果使用 `loadMicroApp`，建议主应用自己维护一个 registry。不要在页面组件里散落一堆 `microApp` 变量，否则后面做重试、销毁、状态面板都会很痛苦。

## 6. 缓存要分三层看

缓存是 qiankun 项目里最容易混淆的部分。这里至少有三种缓存：

### 6.1 静态资源缓存

这是 qiankun 比较擅长的部分。

`start({ prefetch: true })` 默认会在第一个微应用 mount 完成后预加载其他微应用静态资源；`prefetch: 'all'` 则会在主应用启动后预加载所有微应用资源。

```ts
start({
  prefetch: 'all'
})
```

同时，微应用的 `index.html` 不应该被强缓存，JS/CSS chunk 可以走文件 hash + 长缓存。qiankun FAQ 里也提到，微应用文件更新后仍访问旧版文件时，可以给 `index.html` 配置：

```nginx
location = /index.html {
  add_header Cache-Control no-cache;
}
```

这一层解决的是“资源不要重复下载”，不是“组件实例不要销毁”。

### 6.2 数据缓存

数据缓存应该优先交给子应用自己的技术栈。

React 子应用可以用 TanStack Query：

```ts
import {
  QueryClient,
  QueryClientProvider,
  useQuery
} from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 30 * 60 * 1000,
      refetchOnWindowFocus: false
    }
  }
})

function OrderList() {
  const { data, isLoading } = useQuery({
    queryKey: ['orders'],
    queryFn: () => fetch('/api/orders').then((res) => res.json())
  })

  if (isLoading) return <div>Loading...</div>

  return <OrderTable data={data} />
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <OrderList />
    </QueryClientProvider>
  )
}
```

Vue 子应用可以用 Pinia + 持久化插件，或者 Vue Query。重点不是选哪个库，而是让业务数据的缓存策略跟业务代码在一起。主应用最多通知“登录态变化了”、“权限版本变化了”，不要替子应用缓存业务接口响应。

### 6.3 组件实例 / 应用实例缓存

这才是本文最关心的问题：子应用重复加载时，组件实例能不能缓存？

结论需要分场景说。

#### 子应用内部路由切换：可以用框架自己的 keep-alive

如果子应用还处于 mounted 状态，只是在子应用内部切换路由，那么可以用框架自己的缓存方案。

Vue 3：

```vue
<template>
  <router-view v-slot="{ Component }">
    <keep-alive :include="cachedNames">
      <component :is="Component" />
    </keep-alive>
  </router-view>
</template>

<script setup lang="ts">
const cachedNames = ['OrderList', 'OrderDetail']
</script>
```

React 可以使用 `react-activation`、`keepalive-for-react` 或者在路由层自己保存页面状态。

但这里有一个前提：子应用没有被 qiankun 卸载。只要主应用切换路由导致子应用 `unmount` 执行，子应用根实例被销毁，内部的 keep-alive 缓存也就跟着没了。

#### 跨子应用切换后再回来：qiankun 没有官方成熟 keep-alive

基于 `registerMicroApps` 的常规模式里，路由不匹配时 qiankun 会执行子应用的 `unmount`。如果子应用在 `unmount` 中正常执行了：

```ts
root.unmount()
```

或者 Vue 2 里的：

```ts
instance.$destroy()
```

那组件实例自然就不存在了。这个行为是符合生命周期预期的。

社区里确实有一些方案，比如：

- 手动缓存 Vue 实例或 vnode。
- 使用 `loadMicroApp` 自己控制容器显示隐藏。
- 使用一些 `qiankun keep-alive` 的封装库。

这些方案能解决部分问题，但我不认为它们是“无脑可用的成熟方案”。原因主要有几个：

1. qiankun 本身不感知 React/Vue/Angular 的组件实例结构，很难提供跨框架统一 keep-alive。
2. 子应用隐藏但不卸载时，定时器、轮询、WebSocket、全局事件还在运行。
3. 多个保活应用同时存在时，样式、弹窗挂载点、全局快捷键、路由同步都要额外治理。
4. 发版后旧实例还活着，如何让用户拿到新版本，也要设计失效策略。

所以我的建议是：除非用户体验强依赖组件实例保活，否则优先缓存数据和页面参数，不要先缓存应用实例。

## 7. 如果确实要应用级保活，可以这样封装

如果项目是多标签后台，用户在几个子应用之间频繁切换，并且表单编辑态、滚动位置、未提交内容确实不能丢，可以考虑用 `loadMicroApp` 做一层“隐藏而不卸载”的应用缓存。

这个方案的核心不是 `unmount` 后再 `mount`，而是：切换时不调用 `unmount`，只把容器隐藏起来。只有关闭页签、超出缓存上限、退出登录、应用版本变化时才真正 `unmount`。

主应用准备一个缓存容器：

```html
<div id="micro-cache-host"></div>
```

管理器示例：

```ts
// src/micro/keep-alive-manager.ts
import { loadMicroApp, type MicroApp } from 'qiankun'

type KeepAliveConfig = {
  name: string
  entry: string
  props?: Record<string, unknown>
}

type KeepAliveRecord = {
  app: MicroApp
  container: HTMLElement
  lastActiveAt: number
}

const MAX_ALIVE = 3
const records = new Map<string, KeepAliveRecord>()

function getHost() {
  const host = document.querySelector('#micro-cache-host')
  if (!host) {
    throw new Error('#micro-cache-host not found')
  }
  return host
}

function createContainer(name: string) {
  const container = document.createElement('div')
  container.dataset.microName = name
  container.style.width = '100%'
  container.style.height = '100%'
  getHost().appendChild(container)
  return container
}

function hide(record: KeepAliveRecord) {
  record.container.style.display = 'none'
}

function show(record: KeepAliveRecord) {
  record.container.style.display = 'block'
  record.lastActiveAt = Date.now()
}

async function evictIfNeeded(currentName: string) {
  if (records.size <= MAX_ALIVE) return

  const candidates = [...records.entries()]
    .filter(([name]) => name !== currentName)
    .sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt)

  const [name, record] = candidates[0] ?? []
  if (!name || !record) return

  await record.app.unmount()
  record.container.remove()
  records.delete(name)
}

export async function showMicroApp(config: KeepAliveConfig) {
  records.forEach((record, name) => {
    if (name !== config.name) {
      hide(record)
    }
  })

  const cached = records.get(config.name)
  if (cached) {
    show(cached)

    if (cached.app.getStatus() === 'MOUNTED') {
      await cached.app.update(config.props ?? {})
    }

    return cached.app
  }

  const container = createContainer(config.name)
  const app = loadMicroApp({
    name: config.name,
    entry: config.entry,
    container,
    props: config.props
  })

  records.set(config.name, {
    app,
    container,
    lastActiveAt: Date.now()
  })

  await app.mountPromise
  await evictIfNeeded(config.name)

  return app
}

export async function destroyMicroApp(name: string) {
  const record = records.get(name)
  if (!record) return

  await record.app.unmount()
  record.container.remove()
  records.delete(name)
}

export async function destroyAllMicroApps() {
  await Promise.all([...records.keys()].map((name) => destroyMicroApp(name)))
}
```

这个封装一定要配套几条规则：

- 子应用被隐藏时，主应用最好通过 event bus 通知它暂停轮询、视频播放、WebSocket 心跳等副作用。
- 子应用重新显示时，再通知它恢复必要任务。
- 保活数量要有上限，建议 LRU 淘汰。
- 退出登录、租户切换、权限大变更时全部销毁。
- 子应用发版后要有版本号，版本变化时销毁旧实例，避免用户一直操作旧代码。

可以配合事件：

```ts
microEventBus.emit('micro:visibility-change', {
  name: 'order-app',
  visible: false
})
```

子应用里：

```ts
let stopPolling: (() => void) | null = null

export async function mount(props: MicroProps) {
  const off = props.eventBus?.on<{
    name: string
    visible: boolean
  }>('micro:visibility-change', (payload) => {
    if (payload.name !== 'order-app') return

    if (payload.visible) {
      stopPolling = startPolling()
    } else {
      stopPolling?.()
      stopPolling = null
    }
  })

  if (off) {
    disposers.push(off)
  }

  render(props)
}
```

这套方式本质上是“应用级 keep-alive”，不是 qiankun 官方内建能力。它适合强后台、多页签、应用数量可控、主子应用都能统一改造的项目。如果是开放平台式接入很多团队的子应用，我会非常谨慎。

## 8. 成熟替代方案

如果“应用级保活”是项目的一等需求，也可以考虑换框架或调整架构，而不是硬在 qiankun 上补。

### micro-app

`micro-app` 提供了 `keep-alive` 属性：

```html
<micro-app name="order" url="//localhost:7101" keep-alive></micro-app>
```

它的语义是应用隐藏时不销毁，而是推入后台，并提供 `afterhidden`、`beforeshow`、`aftershow` 等生命周期。官方也说明了：应用级 keep-alive 只能保留当前活动页面，如果要缓存子应用内部具体页面或组件，仍然要用 Vue/React 自己的能力。

### wujie

wujie 也有保活模式，思路是通过 iframe + web component 做隔离和复用。它在应用级保活上比 qiankun 更直接，但引入 iframe 之后，路由、弹窗、通信、样式和调试体验也会变成另一套问题。

所以选型时不要只看“有没有 keep-alive”，还要看团队能不能接受它的隔离模型。

## 9. 一套更稳的最佳实践

如果让我给一个 qiankun 项目做基础封装，我会按下面这套来：

### 9.1 主应用只沉淀四个模块

```txt
src/micro/
├── apps.ts              # 子应用注册配置
├── global-state.ts      # initGlobalState 封装
├── event-bus.ts         # 一次性事件
├── status.ts            # 应用生命周期状态
└── keep-alive-manager.ts # 可选，只有强保活场景才启用
```

### 9.2 统一 props 协议

```ts
export type MicroAppProps = {
  basename: string
  getToken: () => string | null
  navigateTo: (url: string) => void
  eventBus: ReturnType<typeof createEventBus>
  onGlobalStateChange: MicroAppStateActions['onGlobalStateChange']
  setGlobalState: MicroAppStateActions['setGlobalState']
  offGlobalStateChange: MicroAppStateActions['offGlobalStateChange']
}
```

所有子应用都只依赖这份协议，不直接读取主应用 store，也不直接 import 主应用代码。

### 9.3 数据规则写清楚

- 登录态、主题、语言：主应用维护，通过 globalState 同步。
- 权限、菜单：主应用维护版本号，子应用按版本号重新拉自己的权限数据。
- 业务接口数据：子应用自己缓存，主应用不接管。
- 跨应用事件：event bus，必须可取消订阅。
- 跨刷新持久化：使用 localStorage、IndexedDB 或后端草稿接口，不依赖组件实例。

### 9.4 缓存策略分层

优先级从高到低：

1. 静态资源：qiankun `prefetch` + HTTP 缓存。
2. 接口数据：TanStack Query / Vue Query / Pinia / Redux Toolkit Query。
3. 页面参数：URL query、sessionStorage 或子应用 store。
4. 子应用内部组件：Vue keep-alive / React keep alive 库。
5. 应用实例保活：`loadMicroApp` + 隐藏容器 + LRU，只有必要时启用。

### 9.5 子应用必须写好 unmount

不管是否保活，子应用都应该能被正确销毁：

```ts
export async function unmount(props: MicroProps) {
  props.offGlobalStateChange?.()

  disposers.forEach((dispose) => dispose())
  disposers = []

  stopPolling?.()
  stopPolling = null

  root?.unmount()
  root = null
}
```

保活不是不写销毁逻辑。恰恰相反，只有销毁逻辑可靠，主应用才敢在缓存淘汰、退出登录、异常恢复时真正释放子应用。

## 10. 总结

qiankun 的通信方案并不复杂，关键在于分层：

- `props` 传稳定配置和主应用能力。
- `initGlobalState` 管少量全局轻状态。
- event bus 处理一次性事件。
- 生命周期和 `MicroApp.getStatus()` 管应用实例状态。
- 缓存优先做资源缓存和数据缓存，组件实例保活放到最后考虑。

关于“子应用重复加载时组件实例能不能缓存”，我的结论是：

> 子应用内部可以缓存；跨 qiankun 卸载再加载，官方没有成熟通用的组件实例缓存方案。强行保活可以用 `loadMicroApp` 隐藏容器，但它是应用级保活，需要配套副作用治理、LRU 淘汰和版本失效策略。

如果只是为了让用户回到页面时少等几秒，大多数时候数据缓存就够了。如果是多页签后台里未提交表单不能丢，那再认真设计应用级保活，不要把它当成一个简单开关。
