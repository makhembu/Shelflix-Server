declare module '@cloudflare/vitest-pool-workers/config' {
  export function defineWorkersConfig<T = any>(config: T): T;
  export default defineWorkersConfig;
}
