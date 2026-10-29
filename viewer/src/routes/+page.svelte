<script lang="ts">
	import {
		agentEntries,
		categoryOf,
		consoleEntries,
		filterConsole,
		filterRows,
		formatSeconds,
		groupWaterfall,
		parseTrace,
		relativeSeconds,
		summarize,
		toCSV,
		toHAR,
		type Category,
		type ParsedTrace
	} from '../lib/trace';

	let parsed = $state<ParsedTrace | null>(null);
	let fileName = $state('');
	let loadError = $state('');
	let query = $state('');
	let loadingSample = $state(false);

	const ALL_CATEGORIES: Category[] = ['navigasi', 'network', 'konsol', 'error', 'tracer', 'agen', 'lainnya'];
	let selectedCategories = $state(new Set<Category>());
	let selectedLevels = $state(new Set<string>());

	const CATEGORY_LABEL: Record<Category, string> = {
		navigasi: 'Navigasi',
		network: 'Network',
		konsol: 'Konsol',
		error: 'Error',
		tracer: 'Tracer',
		agen: 'Agen',
		lainnya: 'Lainnya'
	};

	const CATEGORY_COLOR: Record<Category, string> = {
		navigasi: '#0b3d54',
		network: '#2563eb',
		konsol: '#6b7280',
		error: '#dc2626',
		tracer: '#7c3aed',
		agen: '#059669',
		lainnya: '#9ca3af'
	};

	const LEVEL_OPTIONS = ['log', 'warning', 'error', 'exception'];

	const rows = $derived(parsed?.rows ?? []);
	const skipped = $derived(parsed?.skipped ?? 0);
	const durationMs = $derived(
		rows.length > 1 ? rows[rows.length - 1].mono_ms - rows[0].mono_ms : 0
	);
	const filteredRows = $derived(
		filterRows(rows, query, selectedCategories.size ? [...selectedCategories] : [])
	);
	const waterfall = $derived(groupWaterfall(filteredRows));
	const consoleList = $derived(
		filterConsole(
			consoleEntries(filteredRows),
			selectedLevels.size ? [...selectedLevels] : [],
			query
		)
	);
	const agentList = $derived(agentEntries(filteredRows));
	const counts = $derived(() => {
		const map = new Map<Category, number>();
		for (const row of rows) {
			const c = categoryOf(row.type);
			map.set(c, (map.get(c) ?? 0) + 1);
		}
		return map;
	});
	const timelineRows = $derived(filteredRows.slice(0, 1000));
	const timelineTruncated = $derived(filteredRows.length > timelineRows.length);

	function applyText(text: string, name: string) {
		const result = parseTrace(text);
		if (result.rows.length === 0) {
			parsed = null;
			loadError = `Tidak ada baris trace valid pada "${name}" (${result.skipped} baris dilewati).`;
			return;
		}
		parsed = result;
		fileName = name;
		loadError = '';
	}

	async function onFilePicked(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		applyText(await file.text(), file.name);
	}

	async function loadSample() {
		loadingSample = true;
		loadError = '';
		try {
			const res = await fetch('sample.jsonl');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			applyText(await res.text(), 'sample.jsonl (contoh M1)');
		} catch (e) {
			loadError = `Gagal memuat contoh: ${e instanceof Error ? e.message : String(e)}`;
		} finally {
			loadingSample = false;
		}
	}

	function toggleCategory(cat: Category) {
		if (selectedCategories.has(cat)) selectedCategories.delete(cat);
		else selectedCategories.add(cat);
	}

	function toggleLevel(level: string) {
		if (selectedLevels.has(level)) selectedLevels.delete(level);
		else selectedLevels.add(level);
	}

	function download(name: string, content: string, mime: string) {
		const blob = new Blob([content], { type: mime });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = name;
		a.click();
		URL.revokeObjectURL(url);
	}

	function exportCSV() {
		const base = (rows[0]?.session || 'trace').replace(/[^A-Za-z0-9._-]+/g, '_');
		download(`${base}-filtered.csv`, toCSV(filteredRows), 'text/csv;charset=utf-8');
	}

	function exportHAR() {
		const base = (rows[0]?.session || 'trace').replace(/[^A-Za-z0-9._-]+/g, '_');
		download(
			`${base}-subset.har`,
			JSON.stringify(toHAR(filteredRows, waterfall), null, 2),
			'application/json;charset=utf-8'
		);
	}

	function positionPct(rowMono: number): number {
		if (durationMs <= 0 || rows.length === 0) return 0;
		return Math.max(0, Math.min(100, ((rowMono - rows[0].mono_ms) / durationMs) * 100));
	}
</script>

<main>
	<header>
		<p class="eyebrow">Lightpanda &middot; Lapisan Observabilitas</p>
		<h1>Penampil Trace</h1>
		<p class="notice">
			Trace diredaksi saat perekaman (header sensitif, parameter token, body). Penampil ini
			berjalan sepenuhnya di browser dan <strong>tidak mengirim data ke mana pun</strong>.
		</p>
	</header>

	<section class="loader" aria-label="Muat file trace">
		<label class="file-label">
			Pilih file .jsonl
			<input type="file" accept=".jsonl,.txt" onchange={onFilePicked} />
		</label>
		<button type="button" onclick={loadSample} disabled={loadingSample}>
			{loadingSample ? 'Memuat…' : 'Muat trace contoh'}
		</button>
		{#if fileName}<span class="file-name">{fileName}</span>{/if}
		{#if loadError}<p class="error" role="alert">{loadError}</p>{/if}
	</section>

	{#if parsed}
		<section class="meta" aria-label="Metadata sesi">
			<div><span>Sesi</span><strong>{rows[0]?.session || '—'}</strong></div>
			<div><span>Versi Lightpanda</span><strong>{rows[0]?.lightpanda_version || '—'}</strong></div>
			<div><span>Baris</span><strong>{rows.length}</strong></div>
			<div><span>Baris dilewati</span><strong>{skipped}</strong></div>
			<div><span>Rentang</span><strong>{formatSeconds(durationMs / 1000)}</strong></div>
			<div><span>Ditampilkan</span><strong>{filteredRows.length} baris</strong></div>
		</section>

		<section class="controls" aria-label="Filter dan pencarian">
			<input
				type="search"
				placeholder="Cari URL atau teks konsol…"
				bind:value={query}
				aria-label="Pencarian teks"
			/>
			<div class="chips">
				<button type="button" class:active={selectedCategories.size === 0} onclick={() => selectedCategories.clear()}>
					Semua kategori
				</button>
				{#each ALL_CATEGORIES as cat (cat)}
					<button
						type="button"
						class:active={selectedCategories.has(cat)}
						onclick={() => toggleCategory(cat)}
					>
						{CATEGORY_LABEL[cat]} ({counts().get(cat) ?? 0})
					</button>
				{/each}
			</div>
			<div class="exports">
				<button type="button" onclick={exportCSV}>Ekspor CSV (tampilan saat ini)</button>
				<button type="button" onclick={exportHAR}
					>Ekspor HAR (subset best-effort)</button
				>
			</div>
		</section>

		<section aria-label="Timeline">
			<h2>Timeline</h2>
			<p class="hint">Waktu relatif terhadap baris pertama trace (detik ke-0), dari stempel waktu tracer.</p>
			<div class="axis" aria-hidden="true">
				<span>0 dtk</span><span>{formatSeconds(durationMs / 4000)}</span><span
					>{formatSeconds(durationMs / 2000)}</span
				><span>{formatSeconds((durationMs * 3) / 4000)}</span><span
					>{formatSeconds(durationMs / 1000)}</span
				>
			</div>
			{#if timelineRows.length === 0}
				<p class="empty">Tidak ada event yang cocok dengan filter saat ini.</p>
			{:else}
				<ol class="timeline">
					{#each timelineRows as row (row.seq)}
						<li>
							<span class="time">{formatSeconds(relativeSeconds(rows, row))}</span>
							<span class="track"
								><span
									class="dot"
									style="left: {positionPct(row.mono_ms)}%; background: {CATEGORY_COLOR[categoryOf(row.type)]}"
								></span></span
							>
							<code class="type" style="color: {CATEGORY_COLOR[categoryOf(row.type)]}"
								>{row.type}</code
							>
							<span class="summary">{summarize(row)}</span>
						</li>
					{/each}
				</ol>
				{#if timelineTruncated}
					<p class="hint">
						Menampilkan 1000 baris pertama dari {filteredRows.length} baris terfilter.
					</p>
				{/if}
			{/if}
		</section>

		<section aria-label="Waterfall jaringan">
			<h2>Waterfall Jaringan</h2>
			<p class="hint">
				Durasi dari stempel waktu tracer; breakdown DNS/TLS dan ukuran byte tidak tersedia
				dari CDP dan tidak ditampilkan.
			</p>
			{#if waterfall.length === 0}
				<p class="empty">Tidak ada permintaan jaringan pada tampilan saat ini.</p>
			{:else}
				<div class="table-wrap">
					<table>
						<thead>
							<tr>
								<th>Metode</th>
								<th>URL</th>
								<th>Status</th>
								<th>Tipe</th>
								<th>Mulai</th>
								<th>Respons</th>
								<th>Total</th>
								<th>Hasil</th>
							</tr>
						</thead>
						<tbody>
							{#each waterfall as entry (entry.requestId)}
								<tr>
									<td><code>{entry.method || '—'}</code></td>
									<td class="url">{entry.url || entry.requestId}</td>
									<td>{entry.status || '—'}</td>
									<td>{entry.resourceType || '—'}</td>
									<td>{formatSeconds((entry.startMs - (rows[0]?.mono_ms ?? 0)) / 1000)}</td>
									<td
										>{entry.timeToResponseMs === null
											? '—'
											: `${entry.timeToResponseMs} ms`}</td
									>
									<td>{entry.totalMs === null ? '—' : `${entry.totalMs} ms`}</td>
									<td>
										{#if entry.failed}
											<span class="badge failed">gagal: {entry.errorText || 'error'}</span>
										{:else if entry.endMs !== null}
											<span class="badge ok">selesai</span>
										{:else}
											<span class="badge pending">berjalan</span>
										{/if}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>

		<section aria-label="Panel konsol">
			<h2>Panel Konsol</h2>
			<div class="chips">
				<button type="button" class:active={selectedLevels.size === 0} onclick={() => selectedLevels.clear()}>
					Semua level
				</button>
				{#each LEVEL_OPTIONS as level (level)}
					<button
						type="button"
						class:active={selectedLevels.has(level)}
						onclick={() => toggleLevel(level)}
					>
						{level}
					</button>
				{/each}
			</div>
			{#if consoleList.length === 0}
				<p class="empty">Tidak ada log konsol atau exception yang cocok dengan filter saat ini.</p>
			{:else}
				<ol class="console-list">
					{#each consoleList as entry (entry.row.seq)}
						<li>
							<span class="time">{formatSeconds(relativeSeconds(rows, entry.row))}</span>
							<span class="badge level-{entry.level}">{entry.level}</span>
							<span class="console-text">{entry.text || '(kosong)'}</span>
						</li>
					{/each}
				</ol>
			{/if}
		</section>
		<section aria-label="Panel agen">
			<h2>Panel Agen</h2>
			<p class="hint">
				Langkah tool dari file trace <code>agent --trace</code> upstream (F5), pada sumbu
				waktu yang sama dengan event CDP. Langkah agen yang direkam setelah trace selesai
				mengelompok pada waktu ingest; jalankan tracer bersamaan dengan agen untuk
				korelasi waktu yang akurat.
			</p>
			{#if agentList.length === 0}
				<p class="empty">Tidak ada langkah agen dalam trace ini.</p>
			{:else}
				<ol class="console-list">
					{#each agentList as entry (entry.row.seq)}
						<li>
							<span class="time">{formatSeconds(relativeSeconds(rows, entry.row))}</span>
							<span class="badge">langkah {entry.step}</span>
							<span class="console-text">
								<strong>{entry.name}</strong>
								{entry.ms} ms
								{#if entry.error}
									<span class="badge level-error">error</span>
								{/if}
								{#if entry.pageTitle}
									— {entry.pageTitle}
								{/if}
								{#if entry.httpStatus !== null}
									({entry.httpStatus})
								{/if}
							</span>
						</li>
					{/each}
				</ol>
			{/if}
		</section>
	{:else}
		<p class="empty">
			Belum ada trace dimuat. Pilih file <code>.jsonl</code> hasil tracer M1, atau muat trace contoh.
		</p>
	{/if}

	<footer>
		<p>
			Penampil statis — jalankan lewat server statis lokal (<code>npx serve build</code> atau
			<code>python3 -m http.server</code> dari folder <code>build</code>). Pembukaan lewat
			<code>file://</code> tidak dijanjikan.
		</p>
	</footer>
</main>

<style>
	:global(body) {
		margin: 0;
		font-family:
			system-ui, -apple-system, 'Segoe UI', sans-serif;
		color: #1f2937;
		background: #fff;
	}
	main {
		max-width: 1080px;
		margin: 0 auto;
		padding: 24px 20px 48px;
	}
	.eyebrow {
		margin: 0 0 4px;
		font-size: 12px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: #6b7280;
	}
	h1 {
		margin: 0 0 8px;
		color: #0b3d54;
		font-size: 30px;
	}
	h2 {
		color: #0b3d54;
		font-size: 19px;
		margin: 28px 0 4px;
	}
	.notice {
		background: #fffbeb;
		border: 1px solid #f59e0b;
		padding: 10px 12px;
		border-radius: 6px;
	}
	.loader {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		align-items: center;
		margin-top: 16px;
	}
	.file-label {
		cursor: pointer;
		border: 1px solid #0b3d54;
		color: #0b3d54;
		border-radius: 6px;
		padding: 8px 14px;
		font-weight: 600;
	}
	.file-label input {
		display: none;
	}
	button {
		cursor: pointer;
		border: 1px solid #9ca3af;
		background: #fff;
		border-radius: 6px;
		padding: 8px 12px;
		font: inherit;
	}
	button:disabled {
		opacity: 0.55;
		cursor: wait;
	}
	.file-name {
		color: #4b5563;
	}
	.error {
		color: #b91c1c;
		width: 100%;
		margin: 0;
	}
	.meta {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 28px;
		margin-top: 20px;
		padding: 12px 0;
		border-top: 1px solid #e5e7eb;
		border-bottom: 1px solid #e5e7eb;
	}
	.meta div {
		display: flex;
		flex-direction: column;
	}
	.meta span {
		font-size: 12px;
		color: #6b7280;
	}
	.controls input[type='search'] {
		width: 100%;
		box-sizing: border-box;
		padding: 10px 12px;
		font: inherit;
		border: 1px solid #9ca3af;
		border-radius: 6px;
		margin-top: 16px;
	}
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 10px;
	}
	.chips button.active {
		background: #0b3d54;
		border-color: #0b3d54;
		color: #fff;
	}
	.exports {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 12px;
	}
	.hint {
		color: #6b7280;
		font-size: 13px;
		margin: 0 0 10px;
	}
	.empty {
		color: #6b7280;
	}
	.axis {
		display: flex;
		justify-content: space-between;
		font-size: 12px;
		color: #6b7280;
		border-bottom: 1px solid #e5e7eb;
		padding-bottom: 4px;
	}
	.timeline,
	.console-list {
		list-style: none;
		margin: 8px 0 0;
		padding: 0;
	}
	.timeline li,
	.console-list li {
		display: flex;
		gap: 10px;
		align-items: baseline;
		padding: 5px 0;
		border-bottom: 1px solid #f3f4f6;
		font-size: 14px;
	}
	.time {
		font-variant-numeric: tabular-nums;
		color: #6b7280;
		min-width: 78px;
	}
	.track {
		position: relative;
		flex: 0 0 120px;
		height: 4px;
		background: #e5e7eb;
		border-radius: 2px;
		align-self: center;
	}
	.dot {
		position: absolute;
		top: 50%;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		transform: translate(-50%, -50%);
	}
	.type {
		font-size: 12.5px;
		word-break: break-all;
	}
	.summary {
		word-break: break-all;
		color: #374151;
	}
	.table-wrap {
		overflow-x: auto;
	}
	table {
		border-collapse: collapse;
		width: 100%;
		font-size: 14px;
	}
	th,
	td {
		border: 1px solid #d1d5db;
		padding: 6px 8px;
		text-align: left;
		vertical-align: top;
	}
	th {
		background: #eef4f7;
	}
	td.url {
		word-break: break-all;
	}
	.badge {
		display: inline-block;
		border-radius: 999px;
		padding: 1px 8px;
		font-size: 12px;
		background: #e5e7eb;
	}
	.badge.ok {
		background: #dcfce7;
		color: #166534;
	}
	.badge.failed,
	.badge.level-error,
	.badge.level-exception {
		background: #fee2e2;
		color: #991b1b;
	}
	.badge.level-warning {
		background: #fef3c7;
		color: #92400e;
	}
	.badge.level-log {
		background: #e0e7ff;
		color: #3730a3;
	}
	.console-text {
		word-break: break-all;
		white-space: pre-wrap;
	}
	footer {
		margin-top: 36px;
		border-top: 1px solid #e5e7eb;
		padding-top: 12px;
		color: #6b7280;
		font-size: 13px;
	}
	code {
		background: #f3f4f6;
		padding: 1px 4px;
		border-radius: 3px;
	}
</style>
