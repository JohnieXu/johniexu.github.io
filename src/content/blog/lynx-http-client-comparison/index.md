---
title: "Lynx 移动端 HTTP 请求方案对比：TanStack Query vs Axios"
description: "深入对比 TanStack Query 和 Axios 在 Lynx（ReactLynx）项目中的使用方案，分析各自优缺点及适用场景"
publishDate: 2026-04-27
tags: ["lynx", "react", "http", "tanstack-query", "axios", "移动端"]
heroImage:
  src: './thumbnail.jpg'
  alt: 'thumbnail.jpg'
  color: '#669933'
draft: false
comment: true
---

# Lynx 移动端 HTTP 请求方案对比：TanStack Query vs Axios

## 前言

在 Lynx（字节跳动的跨端框架）项目中进行网络请求时，开发者通常面临两个主要选择：原生 Fetch API 配合 TanStack Query，或者使用 Axios 进行封装。本文将深入对比这两种方案，帮助你在项目中做出合适的技术选型。

## 方案一：TanStack Query + Fetch

### 为什么推荐 TanStack Query？

TanStack Query 是 React 生态系统中最流行的服务端状态管理库，它不仅仅是一个 HTTP 客户端，更是数据获取和缓存管理的完整解决方案。官方文档明确推荐在 ReactLynx 中使用 TanStack Query。

### 核心特性

| 特性 | 说明 |
|------|------|
| 自动缓存 | 开箱即用的请求缓存和自动重新获取 |
| 乐观更新 | 支持 mutations 的乐观更新模式 |
| 后台刷新 | 窗口聚焦时自动刷新 stale 数据 |
| 依赖查询 | 支持查询之间的依赖关系 |
| 分页 & 无限滚动 | 内置支持分页和无限滚动场景 |

### 基础用法

```typescript
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";

const queryClient = new QueryClient();

// 封装请求函数
interface Post {
  userId: number;
  id: number;
  title: string;
  body: string;
}

const fetchPosts = async (): Promise<Post[]> => {
  const response = await fetch("https://jsonplaceholder.typicode.com/posts");
  if (!response.ok) {
    throw new Error("Failed to fetch posts");
  }
  return response.json();
};

// 在组件中使用
function PostList() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["posts"],
    queryFn: fetchPosts,
    staleTime: 5 * 60 * 1000, // 5分钟内不重新获取
  });

  if (isLoading) return <text>Loading...</text>;
  if (isError) return <text>Error: {error.message}</text>;

  return (
    <scroll-view scroll-y>
      {data?.map((post) => (
        <view key={post.id}>
          <text>{post.title}</text>
        </view>
      ))}
    </scroll-view>
  );
}

// 完整应用包装
root.render(
  <QueryClientProvider client={queryClient}>
    <PostList />
  </QueryClientProvider>
);
```

### 高级用法：Mutation 与乐观更新

```typescript
const useDeletePost = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (postId: number) => {
      const response = await fetch(
        `https://jsonplaceholder.typicode.com/posts/${postId}`,
        { method: "DELETE" }
      );
      if (!response.ok) throw new Error("Failed to delete");
      return postId;
    },

    // 乐观更新：在请求完成前就更新 UI
    onMutate: async (postId) => {
      // 取消任何现有的刷新操作
      await queryClient.cancelQueries({ queryKey: ["posts"] });

      // 快照当前数据用于回滚
      const previousPosts = queryClient.getQueryData<Post[]>(["posts"]);

      // 立即更新缓存
      queryClient.setQueryData<Post[]>(["posts"], (old) =>
        old ? old.filter((p) => p.id !== postId) : []
      );

      return { previousPosts };
    },

    // 失败时回滚
    onError: (err, postId, context) => {
      if (context?.previousPosts) {
        queryClient.setQueryData(["posts"], context.previousPosts);
      }
    },

    // 请求完成后刷新数据
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["posts"] });
    },
  });
};

// 组件中使用
function DeleteButton({ postId }) {
  const deletePost = useDeletePost();

  return (
    <view bindtap={() => deletePost.mutate(postId)}>
      <text>Delete</text>
    </view>
  );
}
```

### 分页查询

```typescript
const usePostsPage = (page: number) => {
  return useQuery({
    queryKey: ["posts", page],
    queryFn: async () => {
      const response = await fetch(
        `https://jsonplaceholder.typicode.com/posts?_page=${page}&_limit=10`
      );
      return response.json();
    },
    keepPreviousData: true, // 保持前一页数据直到新数据加载完成
  });
};

// 使用
function PostPage({ pageNum }) {
  const { data, isFetching } = usePostsPage(pageNum);
  return (
    // ...
  );
}
```

### 不足之处

1. **包体积**：作为完整的解决方案，库体积相对较大
2. **概念门槛**：需要理解缓存、失效、重置等核心概念
3. **移动端适配**：某些 web 生态的库可能需要适配 Lynx 环境

---

## 方案二：Axios 封装

### 为什么考虑 Axios？

Axios 是历史悠久的 HTTP 客户端库，API 设计直观，提供请求拦截器、取消请求、自动转换等功能。如果你已经有现成的 Axios 使用经验，或者需要更精细的 HTTP 控制，Axios 是一个合理的选择。

### 核心特性

| 特性 | 说明 |
|------|------|
| 请求/响应拦截器 | 统一的请求前后处理 |
| 自动 JSON 转换 | 自动序列化请求体和解析响应 |
| 请求取消 | 使用 CancelToken 取消请求 |
| 错误处理 | 统一的错误处理结构 |
| 浏览器兼容 | 良好的跨环境兼容性 |

### 基础封装

```typescript
import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from "axios";

// 创建实例
const createApiClient = (baseURL: string): AxiosInstance => {
  const client = axios.create({
    baseURL,
    timeout: 10000,
    headers: {
      "Content-Type": "application/json",
    },
  });

  // 请求拦截器
  client.interceptors.request.use(
    (config) => {
      // 添加 token
      const token = getAuthToken();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      // 请求日志
      console.log(`[Request] ${config.method?.toUpperCase()} ${config.url}`);
      return config;
    },
    (error) => Promise.reject(error)
  );

  // 响应拦截器
  client.interceptors.response.use(
    (response) => {
      console.log(`[Response] ${response.status} ${response.config.url}`);
      return response.data;
    },
    (error: AxiosError) => {
      // 统一错误处理
      if (error.response) {
        switch (error.response.status) {
          case 401:
            handleUnauthorized();
            break;
          case 403:
            handleForbidden();
            break;
          case 404:
            handleNotFound();
            break;
          case 500:
            handleServerError();
            break;
        }
      } else if (error.request) {
        // 请求已发出但没有收到响应
        console.error("Network Error:", error.message);
      }
      return Promise.reject(error);
    }
  );

  return client;
};

// 使用工厂函数
const api = createApiClient("https://api.example.com");

// 封装通用请求方法
export const http = {
  get: <T>(url: string, config?: AxiosRequestConfig) =>
    api.get<T>(url, config),

  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    api.post<T>(url, data, config),

  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    api.put<T>(url, data, config),

  delete: <T>(url: string, config?: AxiosRequestConfig) =>
    api.delete<T>(url, config),

  patch: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) =>
    api.patch<T>(url, data, config),
};
```

### 请求函数封装

```typescript
// types.ts
interface ApiResponse<T> {
  data: T;
  code: number;
  message: string;
}

interface User {
  id: number;
  name: string;
  email: string;
}

// userApi.ts
export const userApi = {
  list: () => http.get<ApiResponse<User[]>>("/users"),

  getById: (id: number) => http.get<ApiResponse<User>>(`/users/${id}`),

  create: (user: Omit<User, "id">) =>
    http.post<ApiResponse<User>>("/users", user),

  update: (id: number, user: Partial<User>) =>
    http.put<ApiResponse<User>>(`/users/${id}`, user),

  delete: (id: number) => http.delete<ApiResponse<void>>(`/users/${id}`),
};

// 组件中使用
function UserList() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    userApi
      .list()
      .then((res) => {
        if (res.code === 0) {
          setUsers(res.data);
        } else {
          setError(res.message);
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  // ...
}
```

### 请求取消

```typescript
// 创建取消令牌
const controller = new AbortController();

// 发送可取消的请求
const fetchUser = async () => {
  try {
    const response = await axios.get("/api/user/1", {
      signal: controller.signal,
    });
    return response.data;
  } catch (error) {
    if (axios.isCancel(error)) {
      console.log("Request was cancelled");
    }
    throw error;
  }
};

// 取消请求
const cancelRequest = () => {
  controller.abort();
};
```

### 与 TanStack Query 结合

如果你既想用 Axios 的便利，又想享受 TanStack Query 的缓存管理，可以结合使用：

```typescript
import { useQuery } from "@tanstack/react-query";
import axios from "axios";

// 封装 Axios 为 queryFn
const fetchWithAxios = async <T>(url: string): Promise<T> => {
  const response = await axios.get<T>(url);
  return response.data;
};

// 组件中使用
function PostList() {
  const { data, isLoading } = useQuery({
    queryKey: ["posts"],
    queryFn: () => fetchWithAxios<Post[]>("https://jsonplaceholder.typicode.com/posts"),
  });

  // ...
}
```

---

## 对比总结

### 功能对比

| 功能 | TanStack Query | Axios |
|------|---------------|-------|
| HTTP 请求 | ❌ 需配合 fetch/axios | ✅ 原生支持 |
| 缓存管理 | ✅ 自动缓存 | ❌ 需自行实现 |
| 乐观更新 | ✅ 内置支持 | ❌ 需自行实现 |
| 后台刷新 | ✅ 支持 | ❌ 需自行实现 |
| 请求拦截 | ❌ 需配合 fetch | ✅ 原生支持 |
| 取消请求 | ✅ 内置 | ✅ 原生 |
| 包体积 | ~14KB (gzipped) | ~14KB (gzipped) |
| 学习曲线 | 较陡 | 平缓 |

### 使用场景建议

**推荐使用 TanStack Query + Fetch：**

- 复杂的数据获取场景（分页、无限滚动）
- 需要乐观更新提升用户体验
- 多处重复获取相同数据的场景
- 需要缓存和自动刷新功能

**推荐使用 Axios：**

- 已经大量使用 Axios 的存量项目迁移
- 需要细粒度的 HTTP 控制
- 请求/响应需要特殊处理（加密、压缩等）
- 团队对 Axios 熟悉度高

### 混合方案

实际上，最佳实践可能是结合两者：

```typescript
// 统一封装
import { QueryClient } from "@tanstack/react-query";
import axios from "axios";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 2,
    },
  },
});

// Axios 实例
const http = axios.create({
  baseURL: "/api",
  timeout: 10000,
});

// 封装查询函数
const queryFn = async <T>(url: string): Promise<T> => {
  const response = await http.get<T>(url);
  return response.data;
};

// 使用
const { data } = useQuery({
  queryKey: ["posts"],
  queryFn: () => queryFn("/posts"),
});
```

---

## Lynx Fetch API 与 Web Fetch 的兼容性差异

在 Web 生态中，Axios 等库对 `XMLHttpRequest` 和 `fetch` 进行了大量兼容性处理，以弥合不同浏览器和环境之间的差异。Lynx 只支持 `fetch` API，这意味着许多 Axios 在 Web 端做的工作在 Lynx 环境中需要手动处理或依赖其他方式。

### Axios 在 Web 端做的兼容性处理（Lynx 中需自行处理的部分）

| 功能 | Web Axios 处理方式 | Lynx Fetch 现状 |
|------|-------------------|-----------------|
| **JSON 自动转换** | 请求时自动 `JSON.stringify`，响应时自动 `response.json()` | 需手动调用 `.json()` |
| **超时控制** | `axios.timeout` 配置 | 需使用 `AbortController` 自行实现 |
| **请求取消** | `CancelToken` 机制 | 原生支持 `AbortController` |
| **HTTP Basic Auth** | 自动处理 `Authorization` 头 | 需手动设置 |
| **XSRF Token** | 自动从 cookie 读取并添加到 header | 需自行实现 |
| **请求进度** | 支持 `onUploadProgress` | **不支持** |
| **响应进度** | 支持 `onDownloadProgress` | **不支持** |
| **FormData 上传** | 自动处理 `multipart/form-data` | 需手动构建 |
| **URL 编码** | 自动处理 `application/x-www-form-urlencoded` | 需手动处理 |
| **重试机制** | 需插件支持 | 需自行实现 |
| **请求拦截器** | 原生支持 | 需封装或使用库 |
| **响应拦截器** | 原生支持 | 需封装或使用库 |
| **错误类型区分** | 区分网络错误、HTTP 错误等 | 需自行判断 |

### 详细差异说明

#### 1. JSON 自动转换

**Web Axios（自动处理）：**
```typescript
// Axios 自动序列化，自动解析
axios.post('/api/user', { name: 'test' })
  .then(res => console.log(res.data)); // 直接得到对象
```

**Lynx Fetch（需手动处理）：**
```typescript
// 需手动 JSON.stringify
fetch('/api/user', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'test' })
}).then(res => res.json()) // 手动调用 .json()
  .then(data => console.log(data));
```

#### 2. 超时控制

**Web Axios：**
```typescript
axios.get('/api/user', { timeout: 5000 });
```

**Lynx Fetch：**
```typescript
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000);

fetch('/api/user', { signal: controller.signal })
  .catch(err => {
    if (err.name === 'AbortError') {
      console.log('Request timeout');
    }
  });
```

#### 3. 请求/响应拦截器

**Web Axios（原生支持）：**
```typescript
axios.interceptors.request.use(config => {
  config.headers['Authorization'] = 'Bearer token';
  return config;
});

axios.interceptors.response.use(
  response => response.data, // 转换响应
  error => { /* 统一错误处理 */ }
);
```

**Lynx Fetch（封装方案）：**
```typescript
// 封装 fetch 拦截器
class FetchClient {
  private interceptors = {
    request: [],
    response: []
  };

  async request(url, options = {}) {
    // 请求拦截
    let config = { ...options };
    for (const fn of this.interceptors.request) {
      config = await fn(config);
    }

    const response = await fetch(url, {
      ...config,
      headers: {
        'Content-Type': 'application/json',
        ...config.headers
      }
    });

    // 响应拦截
    let data = await response.json();
    for (const fn of this.interceptors.response) {
      data = await fn(data, response);
    }

    return data;
  }

  // 添加拦截器方法
  addRequestInterceptor(fn) {
    this.interceptors.request.push(fn);
  }

  addResponseInterceptor(fn) {
    this.interceptors.response.push(fn);
  }
}
```

#### 4. FormData 上传

**Web Axios（自动处理）：**
```typescript
const formData = new FormData();
formData.append('file', file);
formData.append('name', 'test');

axios.post('/api/upload', formData); // 自动设置 Content-Type
```

**Lynx Fetch（需手动处理）：**
```typescript
const formData = new FormData();
formData.append('file', file);
formData.append('name', 'test');

fetch('/api/upload', {
  method: 'POST',
  body: formData
  // 注意：不需要手动设置 Content-Type，fetch 会自动设置
});
```

#### 5. XSRF Token 处理

**Web Axios：**
```typescript
// Axios 自动从 cookie 中读取 xsrf-token 并添加到 header
axios.get('/api/user');
```

**Lynx Fetch（需自行实现）：**
```typescript
function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(^| )${name}=([^;]+)`));
  return match ? match[2] : null;
}

fetch('/api/user', {
  headers: {
    'X-XSRF-TOKEN': getCookie('XSRF-TOKEN')
  }
});
```

#### 6. 错误类型区分

**Web Axios：**
```typescript
axios.get('/api/user')
  .catch(error => {
    if (error.response) {
      // 服务器返回错误状态码
      console.log(error.response.status);
    } else if (error.request) {
      // 请求已发出但没有收到响应
      console.log('Network error');
    } else {
      // 请求配置出错
      console.log('Request error');
    }
  });
```

**Lynx Fetch（需自行判断）：**
```typescript
fetch('/api/user')
  .catch(error => {
    if (error.name === 'AbortError') {
      console.log('Request timeout');
    } else if (error.message) {
      // 网络错误或 Fetch 自身错误
      console.log('Fetch error:', error.message);
    }
  });

// 检查响应状态需在 response.ok 中判断
const response = await fetch('/api/user').catch(error => {
  throw error;
});

if (!response.ok) {
  console.log('HTTP error:', response.status);
}
```

### 进度监控不支持的解决方案

Lynx Fetch **不支持** `onUploadProgress` 和 `onDownloadProgress`，这是与 Web Axios 的重要差异。对于需要显示上传/下载进度的场景，可以考虑：

1. **使用原生 XMLHttpRequest**（如果有暴露）：
```typescript
// 如果 Lynx 环境支持 XMLHttpRequest
const xhr = new XMLHttpRequest();
xhr.upload.onprogress = (e) => {
  if (e.lengthComputable) {
    const percent = (e.loaded / e.total) * 100;
    console.log(`Upload: ${percent}%`);
  }
};
```

2. **使用分段上传**：将大文件分成小块上传，服务端返回已接收的部分。

3. **使用 Server-Sent Events**：服务器推送进度状态，客户端监听更新。

### 完整的 Fetch 封装示例

以下是综合处理的封装方案，模拟了 Axios 的大部分功能：

```typescript
interface FetchOptions extends RequestInit {
  timeout?: number;
  params?: Record<string, string>;
}

interface FetchError extends Error {
  status?: number;
  timeout?: boolean;
}

class LynxFetchClient {
  private baseURL: string;

  constructor(baseURL: string) {
    this.baseURL = baseURL;
  }

  private async request<T>(
    method: string,
    url: string,
    options: FetchOptions = {}
  ): Promise<T> {
    const { timeout = 10000, params, headers, body, ...rest } = options;

    // 构建完整 URL
    let fullUrl = `${this.baseURL}${url}`;
    if (params) {
      const searchParams = new URLSearchParams(params);
      fullUrl += `?${searchParams.toString()}`;
    }

    // 构建 headers
    const mergedHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(headers as Record<string, string>),
    };

    // 添加 token（示例）
    const token = this.getToken();
    if (token) {
      mergedHeaders['Authorization'] = `Bearer ${token}`;
    }

    // 超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(fullUrl, {
        method,
        headers: mergedHeaders,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal: controller.signal,
        ...rest,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const error: FetchError = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }

      return response.json();
    } catch (error: any) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        const timeoutError: FetchError = new Error('Request timeout');
        timeoutError.timeout = true;
        throw timeoutError;
      }
      throw error;
    }
  }

  private getToken(): string | null {
    // 实现获取 token 的逻辑
    return null;
  }

  get<T>(url: string, options?: FetchOptions) {
    return this.request<T>('GET', url, options);
  }

  post<T>(url: string, data?: unknown, options?: FetchOptions) {
    return this.request<T>('POST', url, { ...options, body: data });
  }

  put<T>(url: string, data?: unknown, options?: FetchOptions) {
    return this.request<T>('PUT', url, { ...options, body: data });
  }

  delete<T>(url: string, options?: FetchOptions) {
    return this.request<T>('DELETE', url, options);
  }

  patch<T>(url: string, data?: unknown, options?: FetchOptions) {
    return this.request<T>('PATCH', url, { ...options, body: data });
  }
}

// 使用
const api = new LynxFetchClient('https://api.example.com');

api.get<User[]>('/users').then(users => {
  console.log(users);
}).catch(error => {
  if (error.timeout) {
    console.log('请求超时');
  } else if (error.status) {
    console.log(`HTTP 错误: ${error.status}`);
  }
});
```

---

## 结论

对于 Lynx/ReactLynx 项目，**推荐优先考虑 TanStack Query + Fetch 方案**。它提供了完整的数据获取解决方案，能够显著提升开发效率和用户体验。Axios 则适合需要精细 HTTP 控制或已有存量项目的场景。两者也可以结合使用，取长补短。

最终的技术选型应该基于项目实际需求、团队技术背景和长期维护成本来综合考虑。