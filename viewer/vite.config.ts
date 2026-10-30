import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// Varian single-file: SINGLEFILE=1 mengarahkan output ke
// build-singlefile/; scripts/build-singlefile.mjs kemudian menggabung
// chunk klien menjadi satu modul inline di index.html, sehingga
// penampil bisa dibuka lewat file:// (modul ES yang di-fetch diblokir
// CORS dari origin null). Build default (tanpa flag) tidak berubah.
// (vite-plugin-singlefile sengaja TIDAK dipakai: ia tidak menangani
// dynamic import() boot SvelteKit, sehingga chunk tetap eksternal.)
const single = process.env.SINGLEFILE === '1';

export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({
				pages: single ? 'build-singlefile' : 'build',
				assets: single ? 'build-singlefile' : 'build',
				// Varian single-file: fallback harus beda nama, kalau tidak
				// adapter menimpa index.html hasil prerender dengan
				// cangkang SPA (scripts/build-singlefile.mjs menghapusnya).
				fallback: single ? '200.html' : 'index.html',
				precompress: false,
				strict: true
			})
		})
	]
});
