// Logika murni penampil trace (tanpa dependensi framework) — dapat diuji
// langsung dengan node:test lewat type stripping Node 24. Skema mengikuti
// Lampiran A Dokumen Perancangan v1.1. Durasi selalu dihitung dari
// stempel waktu tracer (ts / mono_ms), BUKAN dari field timing CDP.

export interface TraceRow {
	seq: number;
	ts: string;
	mono_ms: number;
	session: string;
	lightpanda_version: string;
	type: string;
	data: Record<string, unknown>;
	/** URL CDP koneksi asal baris; "" untuk baris bukan-CDP (tracer.*, agent.*) atau trace lama. */
	endpoint: string;
	/** Nomor urut koneksi; -1 untuk baris bukan-CDP atau trace lama. */
	endpoint_index: number;
}

export interface ParsedTrace {
	rows: TraceRow[];
	skipped: number;
}

export type Category = 'navigasi' | 'network' | 'konsol' | 'error' | 'tracer' | 'agen' | 'lainnya';

export function categoryOf(type: string): Category {
	if (type.startsWith('tracer.')) return 'tracer';
	if (type.startsWith('agent.')) return 'agen';
	if (type === 'Runtime.exceptionThrown' || type === 'Network.loadingFailed') return 'error';
	if (type === 'Runtime.consoleAPICalled' || type === 'Log.entryAdded') return 'konsol';
	if (type.startsWith('Page.')) return 'navigasi';
	if (type.startsWith('Network.')) return 'network';
	return 'lainnya';
}

/** Satu baris JSONL -> TraceRow, atau null bila baris bukan baris trace valid. */
export function parseTraceLine(line: string): TraceRow | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	let obj: unknown;
	try {
		obj = JSON.parse(trimmed);
	} catch {
		return null;
	}
	if (typeof obj !== 'object' || obj === null) return null;
	const rec = obj as Record<string, unknown>;
	if (typeof rec.type !== 'string') return null;
	if (typeof rec.data !== 'object' || rec.data === null) return null;
	return {
		seq: typeof rec.seq === 'number' ? rec.seq : 0,
		ts: typeof rec.ts === 'string' ? rec.ts : '',
		mono_ms: typeof rec.mono_ms === 'number' ? rec.mono_ms : 0,
		session: typeof rec.session === 'string' ? rec.session : '',
		lightpanda_version:
			typeof rec.lightpanda_version === 'string' ? rec.lightpanda_version : 'unknown',
		type: rec.type,
		data: rec.data as Record<string, unknown>,
		endpoint: typeof rec.endpoint === 'string' ? rec.endpoint : '',
		endpoint_index: typeof rec.endpoint_index === 'number' ? rec.endpoint_index : -1
	};
}

/** Parse satu pesan SSE mode live (payload `data:`): baris trace atau null bila rusak. */
export function parseLiveEvent(data: string): TraceRow | null {
	return parseTraceLine(data);
}

/** Parse seluruh isi file .jsonl. Baris rusak dilewati dan dihitung, tidak crash. */
export function parseTrace(text: string): ParsedTrace {
	const rows: TraceRow[] = [];
	let skipped = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const row = parseTraceLine(line);
		if (row === null) skipped++;
		else rows.push(row);
	}
	return { rows, skipped };
}

function asString(value: unknown): string {
	if (typeof value === 'string') return value;
	if (value === undefined || value === null) return '';
	try {
		return JSON.stringify(value) ?? '';
	} catch {
		return String(value);
	}
}

function nestedRecord(data: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = data[key];
	if (typeof value === 'object' && value !== null) return value as Record<string, unknown>;
	return null;
}

/**
 * Ambil field dari payload CDP apa adanya: langsung di data, atau bersarang
 * di data.request / data.response (bentuk mentah Network.requestWillBeSent
 * dan Network.responseReceived dari Lightpanda). Mengembalikan '' bila
 * tidak ada.
 */
function pickString(data: Record<string, unknown>, key: string): string {
	const direct = data[key];
	if (typeof direct === 'string' && direct) return direct;
	if (typeof direct === 'number') return String(direct);
	for (const nest of ['request', 'response']) {
		const inner = nestedRecord(data, nest);
		if (!inner) continue;
		const value = inner[key];
		if (typeof value === 'string' && value) return value;
		if (typeof value === 'number') return String(value);
	}
	return '';
}

/** URL permintaan: data.url, data.documentURL, atau request/response.url. */
function urlOf(data: Record<string, unknown>): string {
	return pickString(data, 'url') || pickString(data, 'documentURL');
}

export interface EndpointInfo {
	endpoint: string;
	endpoint_index: number;
	/** Label tampil: URL, ditambah #indeks bila URL yang sama dipakai beberapa koneksi. */
	label: string;
}

/** Kunci unik pasangan (endpoint, indeks) untuk Set filter. */
export function endpointKey(endpoint: string, endpoint_index: number): string {
	return `${endpoint_index}\n${endpoint}`;
}

/** Label pendek untuk lencana: host:port dari URL, atau "tracer" untuk baris bukan-CDP. */
export function shortEndpointLabel(endpoint: string): string {
	if (!endpoint) return 'tracer';
	try {
		return new URL(endpoint).host || endpoint;
	} catch {
		return endpoint;
	}
}

/** Daftar endpoint CDP yang muncul di trace, terurut indeks. */
export function endpointsOf(rows: TraceRow[]): EndpointInfo[] {
	const pairs = new Map<string, { endpoint: string; endpoint_index: number }>();
	for (const row of rows) {
		if (!row.endpoint) continue;
		const key = endpointKey(row.endpoint, row.endpoint_index);
		if (!pairs.has(key)) {
			pairs.set(key, { endpoint: row.endpoint, endpoint_index: row.endpoint_index });
		}
	}
	const indexCount = new Map<string, number>();
	for (const p of pairs.values()) {
		indexCount.set(p.endpoint, (indexCount.get(p.endpoint) ?? 0) + 1);
	}
	return [...pairs.values()]
		.map((p) => ({
			...p,
			label:
				(indexCount.get(p.endpoint) ?? 0) > 1
					? `${p.endpoint} #${p.endpoint_index}`
					: p.endpoint
		}))
		.sort((a, b) => a.endpoint_index - b.endpoint_index);
}

/** true bila trace memuat baris session_resumed (sesi dilanjutkan dengan --append). */
export function hasResumedMarker(rows: TraceRow[]): boolean {
	return rows.some((row) => row.type === 'tracer.session_resumed');
}
export function summarize(row: TraceRow): string {
	const d = row.data;
	switch (row.type) {
		case 'Page.frameNavigated':
			return urlOf(d) || asString(d.frameId);
		case 'Network.requestWillBeSent':
			return `${pickString(d, 'method') || 'GET'} ${urlOf(d)}`;
		case 'Network.responseReceived': {
			const status = pickString(d, 'status');
			return `${status} ${urlOf(d)}`.trim();
		}
		case 'Network.loadingFinished':
		case 'Network.loadingFailed':
			return `${asString(d.requestId)}${d.errorText ? ` — ${asString(d.errorText)}` : ''}`;
		case 'Runtime.consoleAPICalled': {
			const args = Array.isArray(d.args) ? d.args.map(asString).join(' ') : '';
			return `[${asString(d.type)}] ${args}`;
		}
		case 'Runtime.exceptionThrown': {
			const details = d.exceptionDetails as Record<string, unknown> | undefined;
			return (
				asString(details?.text) ||
				asString(details?.exception && (details.exception as Record<string, unknown>).description) ||
				asString(d.text)
			);
		}
		case 'Log.entryAdded': {
			const entry = nestedRecord(d, 'entry');
			if (!entry) return row.type;
			return `[${asString(entry.source)}/${asString(entry.level)}] ${asString(entry.text)}`;
		}
		case 'DOM.documentUpdated':
			return 'dokumen diperbarui (penanda kasar)';
		case 'agent.tool': {
			const page = nestedRecord(d, 'page');
			const title = page ? asString(page.title) : '';
			const ms = typeof d.ms === 'number' ? ` (${d.ms} ms)` : '';
			const err = d.error === true ? ' — error' : '';
			return `${asString(d.name)}${ms}${err}${title ? ` — ${title}` : ''}`;
		}
		case 'agent.run':
			return `agen mulai${d.provider ? ` (${asString(d.provider)}${d.model ? ` / ${asString(d.model)}` : ''})` : ''}`;
		case 'agent.end': {
			const tokens = nestedRecord(d, 'tokens');
			const totalTokens = tokens
				? ['input', 'cached', 'cache_creation', 'output'].reduce(
						(sum, k) => sum + (typeof tokens[k] === 'number' ? (tokens[k] as number) : 0),
						0
					)
				: 0;
			return `agen selesai: ${asString(d.tool_calls)} tool call, ${asString(d.model_calls)} model call, ${totalTokens} token`;
		}
		case 'agent.unknown':
			return `baris agen tak dikenal: ${asString(d.agent_type)}`;
		default:
			if (row.type.startsWith('tracer.')) return asString(d.reason) || asString(d.cdp) || asString(d.path) || row.type;
			if (row.type.startsWith('agent.')) return row.type;
			return urlOf(d) || row.type;
	}
}

/** Level konsol sebagaimana diterima dari CDP. CDP memakai "warning", bukan "warn". */
export function consoleLevel(row: TraceRow): string {
	if (row.type === 'Runtime.exceptionThrown') return 'exception';
	const raw = asString(row.data.type).toLowerCase();
	if (raw === 'warn') return 'warning';
	return raw || 'log';
}

export interface ConsoleEntry {
	row: TraceRow;
	level: string;
	text: string;
	/** Sumber entri Log (mis. "network"); tidak ada untuk consoleAPICalled/exception. */
	source?: string;
}

/** Level panel konsol untuk entri Log: verbose/info -> log, warning/error dipertahankan. */
export function logEntryLevel(row: TraceRow): string {
	const entry = nestedRecord(row.data, 'entry');
	const raw = entry ? asString(entry.level).toLowerCase() : '';
	if (raw === 'verbose' || raw === 'info') return 'log';
	if (raw === 'warning' || raw === 'error') return raw;
	return 'log';
}

/** Entri Panel Konsol: consoleAPICalled + exceptionThrown + Log.entryAdded, terurut waktu. */
export function consoleEntries(rows: TraceRow[]): ConsoleEntry[] {
	const out: ConsoleEntry[] = [];
	for (const row of rows) {
		if (row.type === 'Runtime.consoleAPICalled') {
			const args = Array.isArray(row.data.args) ? row.data.args.map(asString).join(' ') : '';
			out.push({ row, level: consoleLevel(row), text: args });
		} else if (row.type === 'Runtime.exceptionThrown') {
			out.push({ row, level: 'exception', text: summarize(row) });
		} else if (row.type === 'Log.entryAdded') {
			const entry = nestedRecord(row.data, 'entry');
			out.push({
				row,
				level: logEntryLevel(row),
				text: entry ? asString(entry.text) : '',
				source: entry ? asString(entry.source) : ''
			});
		}
	}
	return out;
}

export interface WaterfallEntry {
	requestId: string;
	url: string;
	method: string;
	resourceType: string;
	status: string;
	mimeType: string;
	startMs: number;
	responseMs: number | null;
	endMs: number | null;
	failed: boolean;
	errorText: string;
	/** Teks entri Log.entryAdded untuk request ini (via networkRequestId), atau null bila tidak ada. */
	logText: string | null;
	/** Durasi total dari stempel waktu tracer (ms), atau null bila belum selesai / melintasi batas resume. */
	totalMs: number | null;
	/** Waktu sampai respons pertama dari stempel waktu tracer (ms). */
	timeToResponseMs: number | null;
	endpoint: string;
	endpoint_index: number;
}

function requestIdOf(data: Record<string, unknown>): string {
	return asString(data.requestId);
}

/** Kelompokkan event network per requestId; semua durasi dari mono_ms tracer. */
export function groupWaterfall(rows: TraceRow[]): WaterfallEntry[] {
	const map = new Map<string, WaterfallEntry>();
	const order: string[] = [];
	const get = (id: string, row: TraceRow): WaterfallEntry => {
		let entry = map.get(id);
		if (!entry) {
			entry = {
				requestId: id,
				url: '',
				method: '',
				resourceType: '',
				status: '',
				mimeType: '',
				startMs: 0,
				responseMs: null,
				endMs: null,
				failed: false,
				errorText: '',
				logText: null,
				totalMs: null,
				timeToResponseMs: null,
				endpoint: row.endpoint,
				endpoint_index: row.endpoint_index
			};
			map.set(id, entry);
			order.push(id);
		} else if (!entry.endpoint && row.endpoint) {
			// Baris pendahulu (mis. responseReceived tanpa requestWillBeSent)
			// tidak membawa endpoint; adopsi dari baris berikutnya yang punya.
			entry.endpoint = row.endpoint;
			entry.endpoint_index = row.endpoint_index;
		}
		return entry;
	};
	for (const row of rows) {
		const d = row.data;
		if (row.type === 'Network.requestWillBeSent') {
			const id = requestIdOf(d);
			if (!id) continue;
			const entry = get(id, row);
			entry.startMs = row.mono_ms;
			entry.url = urlOf(d);
			entry.method = pickString(d, 'method') || 'GET';
			entry.resourceType = asString(d.type) || asString(d.resourceType);
		} else if (row.type === 'Network.responseReceived') {
			const id = requestIdOf(d);
			if (!id) continue;
			const entry = get(id, row);
			entry.responseMs = row.mono_ms;
			entry.status = pickString(d, 'status');
			entry.mimeType = pickString(d, 'mimeType');
			if (!entry.url) entry.url = urlOf(d);
		} else if (row.type === 'Network.loadingFinished') {
			const id = requestIdOf(d);
			if (!id) continue;
			get(id, row).endMs = row.mono_ms;
		} else if (row.type === 'Network.loadingFailed') {
			const id = requestIdOf(d);
			if (!id) continue;
			const entry = get(id, row);
			entry.endMs = row.mono_ms;
			entry.failed = true;
			entry.errorText = asString(d.errorText);
		} else if (row.type === 'Log.entryAdded') {
			// Tautkan teks Log ke baris waterfall lewat networkRequestId
			// (terverifikasi sama dengan requestId Network pada 1.0.2).
			// Hanya bila baris Network-nya sudah ada; requestWillBeSent
			// selalu mendahului entri Log untuk request yang sama.
			const entry = nestedRecord(d, 'entry');
			if (entry) {
				const existing = map.get(asString(entry.networkRequestId));
				if (existing) existing.logText = asString(entry.text);
			}
		}
	}
	return order.map((id) => {
		const entry = map.get(id)!;
		// Durasi dari mono_ms; entri yang melintasi batas resume (jam proses
		// baru) menghasilkan selisih negatif dan dilaporkan null, bukan negatif.
		entry.timeToResponseMs =
			entry.responseMs !== null && entry.responseMs >= entry.startMs
				? entry.responseMs - entry.startMs
				: null;
		entry.totalMs =
			entry.endMs !== null && entry.endMs >= entry.startMs ? entry.endMs - entry.startMs : null;
		return entry;
	});
}

export interface AgentEntry {
	row: TraceRow;
	step: number;
	name: string;
	ms: number;
	error: boolean;
	pageTitle: string;
	pageUrl: string;
	httpStatus: number | null;
}

/** Entri Panel Agen (F5): baris agent.tool terurut waktu. */
export function agentEntries(rows: TraceRow[]): AgentEntry[] {
	const out: AgentEntry[] = [];
	for (const row of rows) {
		if (row.type !== 'agent.tool') continue;
		const d = row.data;
		const page = nestedRecord(d, 'page');
		out.push({
			row,
			step: typeof d.step === 'number' ? d.step : 0,
			name: asString(d.name),
			ms: typeof d.ms === 'number' ? d.ms : 0,
			error: d.error === true,
			pageTitle: page ? asString(page.title) : '',
			pageUrl: page ? asString(page.url) : '',
			httpStatus: page && typeof page.httpStatus === 'number' ? page.httpStatus : null
		});
	}
	return out;
}

/** Teks yang dicari: URL + teks konsol + tipe event. */
export function searchableText(row: TraceRow): string {
	const parts = [row.type, summarize(row), urlOf(row.data)];
	if (row.type === 'Runtime.consoleAPICalled' && Array.isArray(row.data.args)) {
		parts.push(row.data.args.map(asString).join(' '));
	}
	if (row.type.startsWith('agent.')) {
		const page = nestedRecord(row.data, 'page');
		if (page) parts.push(asString(page.url), asString(page.title));
	}
	return parts.join(' ').toLowerCase();
}

export function filterRows(
	rows: TraceRow[],
	query: string,
	categories: Category[],
	endpointKeys: string[] = []
): TraceRow[] {
	const q = query.trim().toLowerCase();
	const selected = new Set(endpointKeys);
	return rows.filter((row) => {
		if (categories.length > 0 && !categories.includes(categoryOf(row.type))) return false;
		// Baris bukan-CDP (tracer/agen) tidak terikat endpoint dan selalu lolos filter endpoint.
		if (selected.size > 0 && row.endpoint && !selected.has(endpointKey(row.endpoint, row.endpoint_index))) {
			return false;
		}
		if (q && !searchableText(row).includes(q)) return false;
		return true;
	});
}

export function filterConsole(
	entries: ConsoleEntry[],
	levels: string[],
	query: string
): ConsoleEntry[] {
	const q = query.trim().toLowerCase();
	return entries.filter((entry) => {
		if (levels.length > 0 && !levels.includes(entry.level)) return false;
		if (q) {
			const hay = `${entry.level} ${entry.text} ${entry.row.type}`.toLowerCase();
			if (!hay.includes(q)) return false;
		}
		return true;
	});
}

function csvCell(value: string): string {
	if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
	return value;
}

/** CSV dari baris yang sedang ditampilkan (hasil filter saat ini). */
export function toCSV(rows: TraceRow[]): string {
	const header = [
		'seq',
		'ts',
		'mono_ms',
		'session',
		'lightpanda_version',
		'endpoint',
		'endpoint_index',
		'type',
		'ringkasan'
	];
	const lines = [header.join(',')];
	for (const row of rows) {
		lines.push(
			[
				String(row.seq),
				row.ts,
				String(row.mono_ms),
				row.session,
				row.lightpanda_version,
				row.endpoint,
				String(row.endpoint_index),
				row.type,
				summarize(row)
			]
				.map(csvCell)
				.join(',')
		);
	}
	return lines.join('\r\n') + '\r\n';
}

/**
 * HAR subset best-effort: durasi dari stempel waktu tracer, TANPA breakdown
 * DNS/TLS dan TANPA ukuran byte (datanya tidak tersedia dari CDP).
 * Konsumen HAR tidak boleh mengartikan angka ini sebagai breakdown jaringan.
 */
export function toHAR(rows: TraceRow[], entries: WaterfallEntry[]): Record<string, unknown> {
	const first = rows[0];
	const started = first?.ts || new Date(0).toISOString();
	return {
		log: {
			version: '1.2',
			creator: { name: 'lp-trace-viewer', version: '0.1.0' },
			comment:
				'subset best-effort: durasi dari stempel waktu tracer; tanpa breakdown DNS/TLS dan tanpa ukuran byte.',
			pages: [
				{
					startedDateTime: started,
					id: 'page_1',
					title: first?.session || 'trace',
					pageTimings: { onContentLoad: -1, onLoad: -1 }
				}
			],
			entries: entries.map((entry) => {
				const total = entry.totalMs ?? 0;
				const wait = entry.timeToResponseMs ?? 0;
				return {
					startedDateTime: started,
					time: total,
					request: {
						method: entry.method || 'GET',
						url: entry.url,
						httpVersion: 'HTTP/1.1',
						headers: [],
						queryString: [],
						cookies: [],
						headersSize: -1,
						bodySize: -1
					},
					response: {
						status: entry.status ? Number(entry.status) : 0,
						statusText: entry.failed ? entry.errorText : '',
						httpVersion: 'HTTP/1.1',
						headers: [],
						cookies: [],
						content: { size: -1, mimeType: entry.mimeType || '' },
						redirectURL: '',
						headersSize: -1,
						bodySize: -1
					},
					cache: {},
					timings: {
						blocked: 0,
						dns: -1,
						connect: -1,
						send: 0,
						wait,
						receive: Math.max(0, total - wait),
						ssl: -1
					},
					comment: 'Durasi dari stempel waktu tracer; dns/connect/ssl -1 = tidak tersedia.'
				};
			})
		}
	};
}

/** Waktu relatif dalam detik terhadap baris pertama, 3 desimal.
 * Dihitung dari `ts` absolut (benar lintas proses resume, karena mono_ms
 * mulai dari 0 tiap proses tracer); fallback ke mono_ms bila ts tak ter-parse. */
/**
 * Detik relatif baris terhadap `ts` TERAWAL dalam file (bukan baris
 * pertama urutan file): baris agen berjangkar mtime dapat mendahului
 * `session_started` dalam urutan file, dan detik ke-0 harus menjadi
 * kejadian terawal. Untuk file normal (ts tak menurun) hasilnya sama
 * dengan baris pertama. Fallback ke `mono_ms` minimum bila tidak ada
 * `ts` yang dapat diparse.
 */
export function relativeSeconds(rows: TraceRow[], row: TraceRow): number {
	if (rows.length === 0) return 0;
	let t0 = Number.POSITIVE_INFINITY;
	let m0 = Number.POSITIVE_INFINITY;
	for (const r of rows) {
		const t = Date.parse(r.ts);
		if (!Number.isNaN(t) && t < t0) t0 = t;
		if (r.mono_ms < m0) m0 = r.mono_ms;
	}
	const t1 = Date.parse(row.ts);
	if (t0 !== Number.POSITIVE_INFINITY && !Number.isNaN(t1)) return (t1 - t0) / 1000;
	return (row.mono_ms - (m0 === Number.POSITIVE_INFINITY ? 0 : m0)) / 1000;
}

/** Durasi total trace dalam ms, dari ts terawal–terakhir (fallback mono_ms min–maks). */
export function durationMs(rows: TraceRow[]): number {
	if (rows.length < 2) return 0;
	let tMin = Number.POSITIVE_INFINITY;
	let tMax = Number.NEGATIVE_INFINITY;
	let mMin = Number.POSITIVE_INFINITY;
	let mMax = Number.NEGATIVE_INFINITY;
	for (const r of rows) {
		const t = Date.parse(r.ts);
		if (!Number.isNaN(t)) {
			if (t < tMin) tMin = t;
			if (t > tMax) tMax = t;
		}
		if (r.mono_ms < mMin) mMin = r.mono_ms;
		if (r.mono_ms > mMax) mMax = r.mono_ms;
	}
	if (tMin !== Number.POSITIVE_INFINITY && tMax !== Number.NEGATIVE_INFINITY) {
		return Math.max(0, tMax - tMin);
	}
	return Math.max(0, mMax - mMin);
}

export function formatSeconds(value: number): string {
	return `${value.toFixed(3)} dtk`;
}

// ---- Perbandingan dua trace (COMPARE-DESIGN.md) ----

export interface TraceSummary {
	session: string;
	lightpanda_version: string;
	rows: number;
	skipped: number;
	durationMs: number;
	counts: Record<Category, number>;
	requests: number;
	failedRequests: number;
	consoleEntries: number;
	exceptions: number;
	agentSteps: number;
}

const ALL_CATEGORIES_LIST: Category[] = [
	'navigasi',
	'network',
	'konsol',
	'error',
	'tracer',
	'agen',
	'lainnya'
];

/** Ringkasan satu trace untuk tabel perbandingan (seluruh baris, tanpa filter). */
export function traceSummary(rows: TraceRow[], skipped = 0): TraceSummary {
	const counts = Object.fromEntries(ALL_CATEGORIES_LIST.map((c) => [c, 0])) as Record<
		Category,
		number
	>;
	for (const row of rows) counts[categoryOf(row.type)]++;
	const waterfall = groupWaterfall(rows);
	return {
		session: rows[0]?.session ?? '',
		lightpanda_version: rows[0]?.lightpanda_version ?? '',
		rows: rows.length,
		skipped,
		durationMs: durationMs(rows),
		counts,
		requests: waterfall.length,
		failedRequests: waterfall.filter((e) => e.failed).length,
		consoleEntries: consoleEntries(rows).length,
		exceptions: rows.filter((row) => row.type === 'Runtime.exceptionThrown').length,
		agentSteps: agentEntries(rows).length
	};
}

export interface WaterfallDiff {
	/** Kunci pasangan: metode + URL (atau requestId bila URL kosong). */
	key: string;
	method: string;
	url: string;
	presence: 'both' | 'only-a' | 'only-b';
	statusA: string | null;
	statusB: string | null;
	totalA: number | null;
	totalB: number | null;
	/** Selisih total (B − A) dalam ms; null bila salah satu sisi tanpa durasi. */
	deltaMs: number | null;
}

function waterfallDiffKey(entry: WaterfallEntry): string {
	return `${entry.method}\n${entry.url || entry.requestId}`;
}

/**
 * Pasangkan entri waterfall dua trace berdasarkan kunci metode+URL;
 * kemunculan ke-n dipasangkan dengan kemunculan ke-n. Urutan: pasangan
 * di kedua file (selisih absolut terbesar dulu), lalu hanya-di-A (urut
 * URL), lalu hanya-di-B (urut URL).
 */
export function diffWaterfall(a: TraceRow[], b: TraceRow[]): WaterfallDiff[] {
	const groupByKey = (entries: WaterfallEntry[]): Map<string, WaterfallEntry[]> => {
		const map = new Map<string, WaterfallEntry[]>();
		for (const entry of entries) {
			const key = waterfallDiffKey(entry);
			const list = map.get(key) ?? [];
			list.push(entry);
			map.set(key, list);
		}
		return map;
	};
	const mapA = groupByKey(groupWaterfall(a));
	const mapB = groupByKey(groupWaterfall(b));
	const keys = new Set([...mapA.keys(), ...mapB.keys()]);
	const both: WaterfallDiff[] = [];
	const onlyA: WaterfallDiff[] = [];
	const onlyB: WaterfallDiff[] = [];
	const toDiff = (
		entryA: WaterfallEntry | undefined,
		entryB: WaterfallEntry | undefined
	): WaterfallDiff => {
		const entry = entryA ?? entryB!;
		const totalA = entryA?.totalMs ?? null;
		const totalB = entryB?.totalMs ?? null;
		return {
			key: waterfallDiffKey(entry),
			method: entry.method,
			url: entry.url || entry.requestId,
			presence: entryA && entryB ? 'both' : entryA ? 'only-a' : 'only-b',
			statusA: entryA ? entryA.status || null : null,
			statusB: entryB ? entryB.status || null : null,
			totalA,
			totalB,
			deltaMs: totalA !== null && totalB !== null ? totalB - totalA : null
		};
	};
	for (const key of keys) {
		const listA = mapA.get(key) ?? [];
		const listB = mapB.get(key) ?? [];
		const n = Math.max(listA.length, listB.length);
		for (let i = 0; i < n; i++) {
			const diff = toDiff(listA[i], listB[i]);
			if (diff.presence === 'both') both.push(diff);
			else if (diff.presence === 'only-a') onlyA.push(diff);
			else onlyB.push(diff);
		}
	}
	both.sort((x, y) => {
		const ax = x.deltaMs === null ? -1 : Math.abs(x.deltaMs);
		const ay = y.deltaMs === null ? -1 : Math.abs(y.deltaMs);
		return ay - ax || x.url.localeCompare(y.url);
	});
	onlyA.sort((x, y) => x.url.localeCompare(y.url));
	onlyB.sort((x, y) => x.url.localeCompare(y.url));
	return [...both, ...onlyA, ...onlyB];
}

export interface ConsoleDiffEntry {
	level: string;
	text: string;
	countA: number;
	countB: number;
	/** Selisih kemunculan di sisi yang berlebih. */
	extra: number;
}

export interface ConsoleDiff {
	onlyA: ConsoleDiffEntry[];
	onlyB: ConsoleDiffEntry[];
}

/**
 * Bandingkan entri konsol sebagai multiset berkunci level+teks: kunci
 * yang lebih sering di satu sisi masuk daftar sisi itu sebanyak
 * selisih kemunculannya. Urutan: selisih terbesar dulu, lalu teks.
 */
export function diffConsole(a: TraceRow[], b: TraceRow[]): ConsoleDiff {
	const countByKey = (entries: ConsoleEntry[]): Map<string, { level: string; text: string; count: number }> => {
		const map = new Map<string, { level: string; text: string; count: number }>();
		for (const entry of entries) {
			const key = `${entry.level}\n${entry.text}`;
			const slot = map.get(key) ?? { level: entry.level, text: entry.text, count: 0 };
			slot.count++;
			map.set(key, slot);
		}
		return map;
	};
	const mapA = countByKey(consoleEntries(a));
	const mapB = countByKey(consoleEntries(b));
	const onlyA: ConsoleDiffEntry[] = [];
	const onlyB: ConsoleDiffEntry[] = [];
	for (const [key, slotA] of mapA) {
		const countB = mapB.get(key)?.count ?? 0;
		if (slotA.count > countB) {
			onlyA.push({ level: slotA.level, text: slotA.text, countA: slotA.count, countB, extra: slotA.count - countB });
		}
	}
	for (const [key, slotB] of mapB) {
		const countA = mapA.get(key)?.count ?? 0;
		if (slotB.count > countA) {
			onlyB.push({ level: slotB.level, text: slotB.text, countA, countB: slotB.count, extra: slotB.count - countA });
		}
	}
	const byExtra = (x: ConsoleDiffEntry, y: ConsoleDiffEntry) =>
		y.extra - x.extra || x.text.localeCompare(y.text);
	onlyA.sort(byExtra);
	onlyB.sort(byExtra);
	return { onlyA, onlyB };
}
