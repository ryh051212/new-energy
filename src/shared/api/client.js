// 默认通过网页所在源的 /api 访问服务，开发和预览由 Vite 转发。
export function apiUrl(path, base = import.meta.env?.VITE_API_BASE_URL || '') {
  const endpoint = String(path).replace(/^\/?api(?:\/|$)/, '').replace(/^\/+/, '')
  const prefix = base.trim().replace(/\/+$/, '').replace(/\/api$/, '')
  return `${prefix}/api/${endpoint}`
}

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export async function apiFetch(path, options = {}, fetcher = globalThis.fetch) {
  const response = await fetcher(apiUrl(path), { ...options, credentials: 'include' })
  if (response.status === 401 && !/^\/?(?:api\/)?auth(?:\/|$)/.test(path)) {
    globalThis.dispatchEvent?.(new Event('weidu:unauthorized'))
  }
  return response
}
