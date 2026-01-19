let cfg: any = {};
try {
	// Try to load Cloudflare vitest pool config; if it's not installed during Next build,
	// fall back to a harmless default so the build doesn't fail.
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const mod = await import('@cloudflare/vitest-pool-workers/config');
	const { defineWorkersConfig } = mod;
	cfg = defineWorkersConfig({
		test: {
			poolOptions: {
				workers: {
					wrangler: { configPath: './wrangler.jsonc' },
				},
			},
		},
	});
} catch (e) {
	// fallback no-op config
	cfg = {};
}

export default cfg;
