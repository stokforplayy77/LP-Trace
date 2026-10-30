// Uji logika murni penampil (node:test, tanpa framework). Dijalankan: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	agentEntries,
	categoryOf,
	consoleEntries,
	consoleLevel,
	diffConsole,
	diffWaterfall,
	durationMs,
	endpointKey,
	endpointsOf,
	filterConsole,
	filterRows,
	groupWaterfall,
	hasResumedMarker,
	parseLiveEvent,
	parseTrace,
	parseTraceLine,
	relativeSeconds,
	shortEndpointLabel,
	summarize,
	toCSV,
	toHAR,
	traceSummary
} from '../src/lib/trace.ts';

const EXAMPLE = [
	'{"ts":"2026-10-29T05:44:05.153Z","mono_ms":0,"seq":1,"session":"s1","lightpanda_version":"1.0.2","type":"tracer.session_started","data":{"cdp":"ws://127.0.0.1:9222"}}',
	'{"ts":"2026-10-29T05:44:06.102Z","mono_ms":949,"seq":2,"session":"s1","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"LID-1","url":"https://example.com/","method":"GET","type":"Document"}}',
	'{"ts":"2026-10-29T05:44:06.610Z","mono_ms":1457,"seq":3,"session":"s1","lightpanda_version":"1.0.2","type":"Network.responseReceived","data":{"requestId":"LID-1","url":"https://example.com/","status":200,"mimeType":"text/html"}}',
	'{"ts":"2026-10-29T05:44:07.004Z","mono_ms":1851,"seq":4,"session":"s1","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"log","args":["hello"]}}',
	'{"ts":"2026-10-29T05:44:07.100Z","mono_ms":1947,"seq":5,"session":"s1","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"LID-1"}}',
	'{"ts":"2026-10-29T05:44:07.200Z","mono_ms":2047,"seq":6,"session":"s1","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"warning","args":["hati-hati"]}}',
	'{"ts":"2026-10-29T05:44:07.300Z","mono_ms":2147,"seq":7,"session":"s1","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"error","args":["gagal total"]}}',
	'{"ts":"2026-10-29T05:44:07.400Z","mono_ms":2247,"seq":8,"session":"s1","lightpanda_version":"1.0.2","type":"Runtime.exceptionThrown","data":{"exceptionDetails":{"text":"Uncaught","exception":{"description":"Error: boom"}}}}',
	'{"ts":"2026-10-29T05:44:07.500Z","mono_ms":2347,"seq":9,"session":"s1","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"LID-2","url":"http://127.0.0.1:9/x","method":"GET","type":"Fetch"}}',
	'{"ts":"2026-10-29T05:44:07.600Z","mono_ms":2447,"seq":10,"session":"s1","lightpanda_version":"1.0.2","type":"Network.loadingFailed","data":{"requestId":"LID-2","errorText":"CouldntConnect"}}',
	'{"ts":"2026-10-29T05:44:08.000Z","mono_ms":2847,"seq":11,"session":"s1","lightpanda_version":"1.0.2","type":"tracer.session_ended","data":{}}'
].join('\n');

test('parse: contoh M1 menghasilkan 11 baris, 0 dilewati', () => {
	const { rows, skipped } = parseTrace(EXAMPLE);
	assert.equal(rows.length, 11);
	assert.equal(skipped, 0);
	assert.equal(rows[0].type, 'tracer.session_started');
	assert.equal(rows[0].lightpanda_version, '1.0.2');
});

test('parse: baris rusak dilewati dan dihitung, tidak crash', () => {
	const text = [
		'{"ts":"x","mono_ms":0,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Page.frameNavigated","data":{}}',
		'ini bukan json',
		'{"type":123,"data":{}}',
		'',
		'[1,2,3]',
		'{"type":"Network.requestWillBeSent","data":{"requestId":"R1"}}'
	].join('\n');
	const { rows, skipped } = parseTrace(text);
	assert.equal(rows.length, 2);
	assert.equal(skipped, 3);
});

test('parseTraceLine: baris kosong dan non-objek -> null', () => {
	assert.equal(parseTraceLine(''), null);
	assert.equal(parseTraceLine('  '), null);
	assert.equal(parseTraceLine('"teks"'), null);
});

test('kategori: tracer/error/konsol/navigasi/network/lainnya', () => {
	assert.equal(categoryOf('tracer.session_started'), 'tracer');
	assert.equal(categoryOf('Runtime.exceptionThrown'), 'error');
	assert.equal(categoryOf('Network.loadingFailed'), 'error');
	assert.equal(categoryOf('Runtime.consoleAPICalled'), 'konsol');
	assert.equal(categoryOf('Log.entryAdded'), 'konsol');
	assert.equal(categoryOf('Page.frameNavigated'), 'navigasi');
	assert.equal(categoryOf('Network.requestWillBeSent'), 'network');
	assert.equal(categoryOf('DOM.documentUpdated'), 'lainnya');
});

test('waterfall: durasi dari mono_ms tracer (bukan timing CDP)', () => {
	const { rows } = parseTrace(EXAMPLE);
	const entries = groupWaterfall(rows);
	assert.equal(entries.length, 2);
	const ok = entries.find((e) => e.requestId === 'LID-1');
	assert.ok(ok);
	assert.equal(ok.status, '200');
	assert.equal(ok.mimeType, 'text/html');
	assert.equal(ok.timeToResponseMs, 1457 - 949);
	assert.equal(ok.totalMs, 1947 - 949);
	assert.equal(ok.failed, false);
	const failed = entries.find((e) => e.requestId === 'LID-2');
	assert.ok(failed);
	assert.equal(failed.failed, true);
	assert.equal(failed.errorText, 'CouldntConnect');
	assert.equal(failed.totalMs, 2447 - 2347);
	assert.equal(failed.timeToResponseMs, null);
});

test('waterfall: entri tanpa loadingFinished -> totalMs null', () => {
	const { rows } = parseTrace(
		'{"ts":"x","mono_ms":10,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"R9","url":"https://a.test/","method":"GET"}}'
	);
	const entries = groupWaterfall(rows);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].totalMs, null);
});

test('LOG konsol: entri Log masuk panel konsol dengan pemetaan level + sumber', () => {
	const mk = (seq, entry) =>
		`{"ts":"x","mono_ms":${seq},"seq":${seq},"session":"s","lightpanda_version":"1.0.2","type":"Log.entryAdded","data":{"entry":${JSON.stringify(entry)}}}`;
	const { rows } = parseTrace(
		[
			mk(1, { source: 'network', level: 'verbose', text: 'v', timestamp: 1 }),
			mk(2, { source: 'javascript', level: 'warning', text: 'w', timestamp: 2 }),
			mk(3, { source: 'network', level: 'error', text: 'e', timestamp: 3 }),
			mk(4, { source: 'network', level: 'info', text: 'i', timestamp: 4 })
		].join('\n')
	);
	const entries = consoleEntries(rows);
	assert.deepEqual(
		entries.map((e) => e.level),
		['log', 'warning', 'error', 'log']
	);
	assert.deepEqual(
		entries.map((e) => e.source),
		['network', 'javascript', 'network', 'network']
	);
	assert.deepEqual(
		entries.map((e) => e.text),
		['v', 'w', 'e', 'i']
	);
	assert.equal(summarize(rows[2]), '[network/error] e');
});

test('LOG waterfall: logText tertaut lewat networkRequestId, tanpa stub bila belum ada baris Network', () => {
	const { rows } = parseTrace(
		[
			'{"ts":"x","mono_ms":10,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"R1","url":"https://a.test/","method":"GET"}}',
			'{"ts":"x","mono_ms":20,"seq":2,"session":"s","lightpanda_version":"1.0.2","type":"Network.loadingFailed","data":{"requestId":"R1","errorText":"CouldntConnect"}}',
			'{"ts":"x","mono_ms":30,"seq":3,"session":"s","lightpanda_version":"1.0.2","type":"Log.entryAdded","data":{"entry":{"source":"network","level":"error","text":"Failed to load resource","networkRequestId":"R1"}}}',
			'{"ts":"x","mono_ms":40,"seq":4,"session":"s","lightpanda_version":"1.0.2","type":"Log.entryAdded","data":{"entry":{"source":"network","level":"error","text":"yatim","networkRequestId":"R2"}}}'
		].join('\n')
	);
	const entries = groupWaterfall(rows);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].logText, 'Failed to load resource');
	assert.equal(entries[0].failed, true);
});

test('level konsol: warning dipertahankan; warn dinormalisasi ke warning', () => {
	const { rows } = parseTrace(EXAMPLE);
	const warnRow = parseTraceLine(
		'{"ts":"x","mono_ms":0,"seq":99,"session":"s","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"warn","args":["w"]}}'
	);
	assert.ok(warnRow);
	assert.equal(consoleLevel(warnRow), 'warning');
	const entries = consoleEntries(rows);
	assert.equal(entries.length, 4); // 3 console + 1 exception
	assert.deepEqual(
		entries.map((e) => e.level),
		['log', 'warning', 'error', 'exception']
	);
	assert.equal(entries[3].text, 'Uncaught');
});

test('filter konsol: hanya level yang dipilih', () => {
	const { rows } = parseTrace(EXAMPLE);
	const entries = consoleEntries(rows);
	assert.equal(filterConsole(entries, ['error'], '').length, 1);
	assert.equal(filterConsole(entries, ['log', 'warning'], '').length, 2);
	assert.equal(filterConsole(entries, [], '').length, 4);
	assert.equal(filterConsole(entries, ['exception'], '').length, 1);
});

test('pencarian: cocok pada URL dan pada teks konsol', () => {
	const { rows } = parseTrace(EXAMPLE);
	assert.equal(filterRows(rows, 'example.com', []).length, 2); // request + response
	assert.equal(filterRows(rows, 'gagal total', []).length, 1);
	assert.equal(filterRows(rows, 'tidak-ada-yang-cocok', []).length, 0);
	assert.equal(filterRows(rows, '', []).length, 11);
});

test('filter kategori: hanya kategori terpilih', () => {
	const { rows } = parseTrace(EXAMPLE);
	assert.equal(filterRows(rows, '', ['error']).length, 2); // exception + loadingFailed
	assert.equal(filterRows(rows, '', ['tracer']).length, 2);
});

test('ringkasan: exception memakai teks exceptionDetails', () => {
	const { rows } = parseTrace(EXAMPLE);
	const exc = rows.find((r) => r.type === 'Runtime.exceptionThrown');
	assert.ok(exc);
	assert.equal(summarize(exc), 'Uncaught');
});

test('CSV: header + baris + escaping koma/kutip', () => {
	const { rows } = parseTrace(EXAMPLE);
	const csv = toCSV(rows.slice(0, 2));
	const lines = csv.split('\r\n');
	assert.equal(lines[0], 'seq,ts,mono_ms,session,lightpanda_version,endpoint,endpoint_index,type,ringkasan');
	assert.ok(lines[1].includes('tracer.session_started'));
	const tricky = parseTraceLine(
		'{"ts":"x","mono_ms":0,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"log","args":["a, \\"b\\""]}}'
	);
	assert.ok(tricky);
	const csv2 = toCSV([tricky]);
	assert.ok(csv2.includes('""b""'));
});

test('bentuk mentah CDP: url/metode bersarang di request, status di response', () => {
	const { rows } = parseTrace(
		[
			'{"ts":"x","mono_ms":0,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"R1","type":"Document","request":{"url":"https://a.test/p","method":"POST"}}}',
			'{"ts":"x","mono_ms":50,"seq":2,"session":"s","lightpanda_version":"1.0.2","type":"Network.responseReceived","data":{"requestId":"R1","response":{"url":"https://a.test/p","status":201,"mimeType":"application/json"}}}',
			'{"ts":"x","mono_ms":80,"seq":3,"session":"s","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"R1"}}'
		].join('\n')
	);
	const entries = groupWaterfall(rows);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].url, 'https://a.test/p');
	assert.equal(entries[0].method, 'POST');
	assert.equal(entries[0].status, '201');
	assert.equal(entries[0].mimeType, 'application/json');
	assert.equal(entries[0].totalMs, 80);
	// loadingFinished hanya membawa requestId (tanpa URL), jadi 2 dari 3 baris cocok.
	assert.equal(filterRows(rows, 'a.test/p', []).length, 2);
});

test('HAR: subset best-effort — dns/connect/ssl -1, ukuran -1, ada komentar', () => {
	const { rows } = parseTrace(EXAMPLE);
	const har = toHAR(rows, groupWaterfall(rows));
	const log = har.log;
	assert.ok(log && typeof log === 'object');
	const entries = log.entries;
	assert.ok(Array.isArray(entries));
	assert.equal(entries.length, 2);
	const first = entries[0];
	assert.equal(first.timings.dns, -1);
	assert.equal(first.timings.connect, -1);
	assert.equal(first.timings.ssl, -1);
	assert.equal(first.response.bodySize, -1);
	assert.equal(first.time, 1947 - 949);
	assert.ok(String(log.comment).includes('best-effort'));
});

// ---------- F5: baris agen ----------

const AGENT_EXAMPLE = [
	'{"ts":"2026-10-29T06:00:00.000Z","mono_ms":0,"seq":1,"session":"f5","lightpanda_version":"1.0.2","type":"tracer.session_started","data":{"cdp":"ws://127.0.0.1:9222"}}',
	'{"ts":"2026-10-29T06:00:00.010Z","mono_ms":10,"seq":2,"session":"f5","lightpanda_version":"1.0.2","type":"tracer.agent_attached","data":{"path":"./agent-trace.jsonl"}}',
	'{"ts":"2026-10-29T06:00:00.020Z","mono_ms":20,"seq":3,"session":"f5","lightpanda_version":"1.0.2","type":"agent.run","data":{"provider":"none","model":""}}',
	'{"ts":"2026-10-29T06:00:00.030Z","mono_ms":30,"seq":4,"session":"f5","lightpanda_version":"1.0.2","type":"agent.tool","data":{"step":1,"name":"goto","ms":4,"agent_t":9,"error":false,"navigated":true,"result_bytes":6,"page":{"url":"http://127.0.0.1:8765/ok.html","httpStatus":200,"title":"F5 OK"}}}',
	'{"ts":"2026-10-29T06:00:00.040Z","mono_ms":40,"seq":5,"session":"f5","lightpanda_version":"1.0.2","type":"agent.tool","data":{"step":2,"name":"extract","ms":0,"agent_t":10,"error":false,"navigated":false,"result_bytes":38,"args":{"schema":"{\\"title\\":\\"title\\"}"},"page":{"url":"http://127.0.0.1:8765/ok.html","httpStatus":200,"title":"F5 OK"}}}',
	'{"ts":"2026-10-29T06:00:00.050Z","mono_ms":50,"seq":6,"session":"f5","lightpanda_version":"1.0.2","type":"agent.tool","data":{"step":3,"name":"evaluate","ms":2,"agent_t":11,"error":true,"navigated":false,"result_bytes":342,"args":{"script":"throw new Error(\\"boom\\")"},"page":{"url":"http://127.0.0.1:8765/missing.html","httpStatus":404,"title":""}}}',
	'{"ts":"2026-10-29T06:00:00.060Z","mono_ms":60,"seq":7,"session":"f5","lightpanda_version":"1.0.2","type":"agent.unknown","data":{"agent_type":"model","agent_t":12}}',
	'{"ts":"2026-10-29T06:00:00.070Z","mono_ms":70,"seq":8,"session":"f5","lightpanda_version":"1.0.2","type":"agent.end","data":{"model_calls":2,"tool_calls":3,"tokens":{"input":10,"cached":2,"cache_creation":1,"output":5}}}',
	'{"ts":"2026-10-29T06:00:00.080Z","mono_ms":80,"seq":9,"session":"f5","lightpanda_version":"1.0.2","type":"tracer.session_ended","data":{"reason":"signal-SIGINT","agentLines":5,"agentSkipped":0,"agentResets":0}}'
].join('\n');

test('F5 kategori: semua tipe agent.* -> agen, penanda tracer tetap tracer', () => {
	assert.equal(categoryOf('agent.tool'), 'agen');
	assert.equal(categoryOf('agent.run'), 'agen');
	assert.equal(categoryOf('agent.end'), 'agen');
	assert.equal(categoryOf('agent.unknown'), 'agen');
	assert.equal(categoryOf('tracer.agent_attached'), 'tracer');
	assert.equal(categoryOf('tracer.agent_reset'), 'tracer');
	const { rows } = parseTrace(AGENT_EXAMPLE);
	assert.equal(filterRows(rows, '', ['agen']).length, 6);
	assert.equal(filterRows(rows, '', ['tracer']).length, 3);
});

test('F5 ringkasan: agent.tool/run/end/unknown', () => {
	const { rows } = parseTrace(AGENT_EXAMPLE);
	const byType = (t) => rows.find((r) => r.type === t);
	assert.equal(summarize(byType('agent.tool')), 'goto (4 ms) — F5 OK');
	const errorTool = rows.filter((r) => r.type === 'agent.tool')[2];
	assert.equal(summarize(errorTool), 'evaluate (2 ms) — error');
	assert.equal(summarize(byType('agent.run')), 'agen mulai (none)');
	assert.equal(
		summarize(byType('agent.end')),
		'agen selesai: 3 tool call, 2 model call, 18 token'
	);
	assert.equal(summarize(byType('agent.unknown')), 'baris agen tak dikenal: model');
});

test('F5 agentEntries: hanya agent.tool, terurut, field lengkap', () => {
	const { rows } = parseTrace(AGENT_EXAMPLE);
	const entries = agentEntries(rows);
	assert.equal(entries.length, 3);
	assert.deepEqual(
		entries.map((e) => e.name),
		['goto', 'extract', 'evaluate']
	);
	assert.deepEqual(
		entries.map((e) => e.step),
		[1, 2, 3]
	);
	assert.equal(entries[0].ms, 4);
	assert.equal(entries[0].pageTitle, 'F5 OK');
	assert.equal(entries[0].pageUrl, 'http://127.0.0.1:8765/ok.html');
	assert.equal(entries[0].httpStatus, 200);
	assert.equal(entries[0].error, false);
	assert.equal(entries[2].error, true);
	assert.equal(entries[2].httpStatus, 404);
	assert.equal(entries[2].pageTitle, '');
	// Baris non-tool tidak masuk panel agen.
	assert.equal(agentEntries(parseTrace(EXAMPLE).rows).length, 0);
});

test('F5 pencarian: nama tool dan judul halaman agen ditemukan', () => {
	const { rows } = parseTrace(AGENT_EXAMPLE);
	assert.equal(filterRows(rows, 'evaluate', []).length, 1);
	assert.equal(filterRows(rows, 'goto', []).length, 1);
	assert.equal(filterRows(rows, 'f5 ok', []).length, 2);
	assert.equal(filterRows(rows, 'missing.html', []).length, 1);
	// Kombinasi kategori + query.
	assert.equal(filterRows(rows, 'extract', ['agen']).length, 1);
	assert.equal(filterRows(rows, 'extract', ['network']).length, 0);
});

test('F5 CSV: baris agen ikut dengan ringkasannya', () => {
	const { rows } = parseTrace(AGENT_EXAMPLE);
	const csv = toCSV(rows);
	const lines = csv.split('\r\n');
	assert.equal(lines[0], 'seq,ts,mono_ms,session,lightpanda_version,endpoint,endpoint_index,type,ringkasan');
	assert.ok(csv.includes('agent.tool'));
	assert.ok(csv.includes('goto (4 ms)'));
	assert.ok(csv.includes('agen selesai: 3 tool call, 2 model call, 18 token'));
	assert.ok(csv.includes('baris agen tak dikenal: model'));
});

test('MS parse: field endpoint/endpoint_index dibaca; trace lama default kosong/-1', () => {
	const line =
		'{"ts":"2026-10-29T05:44:05.153Z","mono_ms":0,"seq":1,"session":"s1","lightpanda_version":"1.0.2","endpoint":"ws://127.0.0.1:9222","endpoint_index":1,"type":"Network.requestWillBeSent","data":{}}';
	const row = parseTraceLine(line);
	assert.equal(row.endpoint, 'ws://127.0.0.1:9222');
	assert.equal(row.endpoint_index, 1);
	const old = parseTraceLine(
		'{"ts":"2026-10-29T05:44:06.102Z","mono_ms":949,"seq":2,"session":"s1","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{}}'
	);
	assert.equal(old.endpoint, '');
	assert.equal(old.endpoint_index, -1);
});

test('MS endpointsOf: URL duplikat dilabeli #indeks, URL tunggal polos', () => {
	const mk = (endpoint, endpoint_index, seq) =>
		`{"ts":"2026-10-29T05:44:05.153Z","mono_ms":0,"seq":${seq},"session":"s1","lightpanda_version":"1.0.2","endpoint":"${endpoint}","endpoint_index":${endpoint_index},"type":"Network.requestWillBeSent","data":{}}`;
	const rows = parseTrace(
		[
			mk('ws://127.0.0.1:9222', 0, 1),
			mk('ws://127.0.0.1:9222', 1, 2),
			mk('ws://127.0.0.1:9223', 2, 3)
		].join('\n')
	).rows;
	const eps = endpointsOf(rows);
	assert.deepEqual(
		eps.map((e) => e.label),
		['ws://127.0.0.1:9222 #0', 'ws://127.0.0.1:9222 #1', 'ws://127.0.0.1:9223']
	);
	assert.equal(shortEndpointLabel('ws://127.0.0.1:9222'), '127.0.0.1:9222');
	assert.equal(shortEndpointLabel(''), 'tracer');
});

test('MS filterRows: filter endpoint hanya menyaring baris CDP; baris tracer selalu lolos', () => {
	const mk = (type, endpoint, endpoint_index, seq) =>
		`{"ts":"2026-10-29T05:44:05.153Z","mono_ms":0,"seq":${seq},"session":"s1","lightpanda_version":"1.0.2","endpoint":"${endpoint}","endpoint_index":${endpoint_index},"type":"${type}","data":{}}`;
	const rows = parseTrace(
		[
			mk('tracer.session_started', '', -1, 1),
			mk('Network.requestWillBeSent', 'ws://127.0.0.1:9222', 0, 2),
			mk('Network.requestWillBeSent', 'ws://127.0.0.1:9222', 1, 3)
		].join('\n')
	).rows;
	const filtered = filterRows(rows, '', [], [endpointKey('ws://127.0.0.1:9222', 0)]);
	assert.deepEqual(
		filtered.map((r) => r.seq),
		[1, 2]
	);
	assert.equal(hasResumedMarker(rows), false);
	const resumedRows = parseTrace(
		'{"ts":"2026-10-29T05:44:05.153Z","mono_ms":0,"seq":1,"session":"s1","lightpanda_version":"1.0.2","type":"tracer.session_resumed","data":{}}'
	).rows;
	assert.equal(hasResumedMarker(resumedRows), true);
});

test('MS waktu relatif: dari ts, benar walau mono_ms reset di batas resume', () => {
	const mk = (ts, mono_ms, seq) =>
		`{"ts":"${ts}","mono_ms":${mono_ms},"seq":${seq},"session":"s1","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{}}`;
	const rows = parseTrace(
		[
			mk('2026-10-29T07:00:00.000Z', 0, 1),
			mk('2026-10-29T07:00:01.000Z', 900, 2),
			mk('2026-10-29T07:00:01.500Z', 0, 3),
			mk('2026-10-29T07:00:02.000Z', 300, 4)
		].join('\n')
	).rows;
	assert.deepEqual(
		rows.map((r) => relativeSeconds(rows, r)),
		[0, 1, 1.5, 2]
	);
	assert.equal(durationMs(rows), 2000);
});

test('ANCHOR waktu relatif: nol = ts terawal, baris agen berjangkar yang mendahului sesi tidak negatif', () => {
	const mk = (ts, mono_ms, seq, type) =>
		`{"ts":"${ts}","mono_ms":${mono_ms},"seq":${seq},"session":"s1","lightpanda_version":"1.0.2","type":"${type}","data":{}}`;
	const rows = parseTrace(
		[
			mk('2026-10-29T07:00:05.000Z', 0, 1, 'tracer.session_started'),
			mk('2026-10-29T07:00:00.000Z', 0, 2, 'agent.tool'),
			mk('2026-10-29T07:00:02.000Z', 0, 3, 'agent.tool'),
			mk('2026-10-29T07:00:06.000Z', 1000, 4, 'tracer.session_ended')
		].join('\n')
	).rows;
	assert.deepEqual(
		rows.map((r) => relativeSeconds(rows, r)),
		[5, 0, 2, 6]
	);
	assert.equal(durationMs(rows), 6000);
});

test('MS CSV: header memuat kolom endpoint', () => {
	const csv = toCSV(parseTrace(EXAMPLE).rows);
	assert.ok(csv.startsWith('seq,ts,mono_ms,session,lightpanda_version,endpoint,endpoint_index,type,ringkasan'));
});

test('MS waterfall: endpoint terbawa; durasi negatif lintas resume menjadi null', () => {
	const mk = (type, mono_ms, seq, endpoint, endpoint_index, data) =>
		`{"ts":"2026-10-29T07:00:00.000Z","mono_ms":${mono_ms},"seq":${seq},"session":"s1","lightpanda_version":"1.0.2","endpoint":"${endpoint}","endpoint_index":${endpoint_index},"type":"${type}","data":${JSON.stringify(data)}}`;
	const rows = parseTrace(
		[
			mk('Network.requestWillBeSent', 2000, 1, 'ws://127.0.0.1:9222', 0, {
				requestId: 'LID-9',
				url: 'https://example.com/',
				method: 'GET',
				type: 'Document'
			}),
			mk('Network.loadingFinished', 50, 2, 'ws://127.0.0.1:9222', 0, { requestId: 'LID-9' })
		].join('\n')
	).rows;
	const wf = groupWaterfall(rows);
	assert.equal(wf.length, 1);
	assert.equal(wf[0].endpoint, 'ws://127.0.0.1:9222');
	assert.equal(wf[0].endpoint_index, 0);
	assert.equal(wf[0].totalMs, null);
});

test('LIVE parseLiveEvent: payload SSE valid jadi baris; rusak jadi null', () => {
	const row = parseLiveEvent(
		'{"ts":"2026-10-29T07:00:00.000Z","mono_ms":10,"seq":1,"session":"s1","lightpanda_version":"1.0.2","endpoint":"ws://127.0.0.1:9222","endpoint_index":0,"type":"Network.requestWillBeSent","data":{}}'
	);
	assert.ok(row);
	assert.equal(row.type, 'Network.requestWillBeSent');
	assert.equal(row.endpoint_index, 0);
	assert.equal(parseLiveEvent('{bukan json'), null);
	assert.equal(parseLiveEvent(''), null);
	assert.equal(parseLiveEvent('{"type":123,"data":{}}'), null);
});

test('LIVE baris dari SSE mengalir ke waterfall/filter yang sama', () => {
	const rows = [
		parseLiveEvent(
			'{"ts":"2026-10-29T07:00:00.000Z","mono_ms":0,"seq":1,"session":"s1","lightpanda_version":"1.0.2","endpoint":"ws://127.0.0.1:9222","endpoint_index":0,"type":"Network.requestWillBeSent","data":{"requestId":"L1","url":"https://example.com/live","method":"GET","type":"Document"}}'
		),
		parseLiveEvent(
			'{"ts":"2026-10-29T07:00:00.100Z","mono_ms":100,"seq":2,"session":"s1","lightpanda_version":"1.0.2","endpoint":"ws://127.0.0.1:9222","endpoint_index":0,"type":"Network.loadingFinished","data":{"requestId":"L1"}}'
		)
	].filter(Boolean);
	const wf = groupWaterfall(rows);
	assert.equal(wf.length, 1);
	assert.equal(wf[0].url, 'https://example.com/live');
	assert.equal(wf[0].totalMs, 100);
	assert.equal(filterRows(rows, 'live', []).length, 1);
});

// ---- Perbandingan dua trace (COMPARE-DESIGN.md) ----

const TRACE_A = [
	'{"ts":"2026-10-30T01:00:00.000Z","mono_ms":0,"seq":1,"session":"sA","lightpanda_version":"1.0.2","type":"tracer.session_started","data":{}}',
	'{"ts":"2026-10-30T01:00:00.100Z","mono_ms":100,"seq":2,"session":"sA","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"LID-1","url":"https://example.com/a","method":"GET","type":"Document"}}',
	'{"ts":"2026-10-30T01:00:00.150Z","mono_ms":150,"seq":3,"session":"sA","lightpanda_version":"1.0.2","type":"Network.responseReceived","data":{"requestId":"LID-1","url":"https://example.com/a","status":200,"mimeType":"text/html"}}',
	'{"ts":"2026-10-30T01:00:00.200Z","mono_ms":200,"seq":4,"session":"sA","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"LID-1"}}',
	'{"ts":"2026-10-30T01:00:00.300Z","mono_ms":300,"seq":5,"session":"sA","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"LID-2","url":"https://example.com/b","method":"GET","type":"Document"}}',
	'{"ts":"2026-10-30T01:00:00.350Z","mono_ms":350,"seq":6,"session":"sA","lightpanda_version":"1.0.2","type":"Network.responseReceived","data":{"requestId":"LID-2","url":"https://example.com/b","status":200}}',
	'{"ts":"2026-10-30T01:00:00.400Z","mono_ms":400,"seq":7,"session":"sA","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"LID-2"}}',
	'{"ts":"2026-10-30T01:00:00.500Z","mono_ms":500,"seq":8,"session":"sA","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"log","args":["hello"]}}',
	'{"ts":"2026-10-30T01:00:00.600Z","mono_ms":600,"seq":9,"session":"sA","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"log","args":["hello"]}}',
	'{"ts":"2026-10-30T01:00:00.700Z","mono_ms":700,"seq":10,"session":"sA","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"warning","args":["lama"]}}',
	'{"ts":"2026-10-30T01:00:00.800Z","mono_ms":800,"seq":11,"session":"sA","lightpanda_version":"1.0.2","type":"Runtime.exceptionThrown","data":{"exceptionDetails":{"text":"boom"}}}',
	'{"ts":"2026-10-30T01:00:00.900Z","mono_ms":900,"seq":12,"session":"sA","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"LID-3","url":"https://example.com/d","method":"GET","type":"Fetch"}}',
	'{"ts":"2026-10-30T01:00:00.950Z","mono_ms":950,"seq":13,"session":"sA","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"LID-3"}}',
	'{"ts":"2026-10-30T01:00:01.000Z","mono_ms":1000,"seq":14,"session":"sA","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"LID-4","url":"https://example.com/d","method":"GET","type":"Fetch"}}',
	'{"ts":"2026-10-30T01:00:01.100Z","mono_ms":1100,"seq":15,"session":"sA","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"LID-4"}}',
	'{"ts":"2026-10-30T01:00:01.200Z","mono_ms":1200,"seq":16,"session":"sA","lightpanda_version":"1.0.2","type":"tracer.session_ended","data":{}}'
].join('\n');

const TRACE_B = [
	'{"ts":"2026-10-30T02:00:00.000Z","mono_ms":0,"seq":1,"session":"sB","lightpanda_version":"1.0.2","type":"tracer.session_started","data":{}}',
	'{"ts":"2026-10-30T02:00:00.100Z","mono_ms":100,"seq":2,"session":"sB","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"M1","url":"https://example.com/a","method":"GET","type":"Document"}}',
	'{"ts":"2026-10-30T02:00:00.200Z","mono_ms":200,"seq":3,"session":"sB","lightpanda_version":"1.0.2","type":"Network.responseReceived","data":{"requestId":"M1","url":"https://example.com/a","status":404}}',
	'{"ts":"2026-10-30T02:00:00.250Z","mono_ms":250,"seq":4,"session":"sB","lightpanda_version":"1.0.2","type":"Network.loadingFinished","data":{"requestId":"M1"}}',
	'{"ts":"2026-10-30T02:00:00.300Z","mono_ms":300,"seq":5,"session":"sB","lightpanda_version":"1.0.2","type":"Network.requestWillBeSent","data":{"requestId":"M2","url":"https://example.com/c","method":"GET","type":"Fetch"}}',
	'{"ts":"2026-10-30T02:00:00.400Z","mono_ms":400,"seq":6,"session":"sB","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"log","args":["hello"]}}',
	'{"ts":"2026-10-30T02:00:00.500Z","mono_ms":500,"seq":7,"session":"sB","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"error","args":["baru"]}}',
	'{"ts":"2026-10-30T02:00:00.600Z","mono_ms":600,"seq":8,"session":"sB","lightpanda_version":"1.0.2","type":"tracer.session_ended","data":{}}'
].join('\n');

const rowsA = parseTrace(TRACE_A).rows;
const rowsB = parseTrace(TRACE_B).rows;

test('COMPARE ringkasan: kategori, durasi, sesi, dan agregat network/konsol', () => {
	const sa = traceSummary(rowsA, 2);
	assert.equal(sa.session, 'sA');
	assert.equal(sa.rows, 16);
	assert.equal(sa.skipped, 2);
	assert.equal(sa.durationMs, 1200);
	assert.equal(sa.counts.network, 10);
	assert.equal(sa.counts.konsol, 3);
	assert.equal(sa.counts.error, 1);
	assert.equal(sa.counts.tracer, 2);
	assert.equal(sa.requests, 4);
	assert.equal(sa.failedRequests, 0);
	assert.equal(sa.consoleEntries, 4);
	assert.equal(sa.exceptions, 1);
	assert.equal(sa.agentSteps, 0);
	const sb = traceSummary(rowsB);
	assert.equal(sb.session, 'sB');
	assert.equal(sb.durationMs, 600);
	assert.equal(sb.counts.network, 4);
	assert.equal(sb.requests, 2);
	assert.equal(sb.consoleEntries, 2);
});

test('COMPARE waterfall: pasangan cocok, status berubah, selisih durasi, duplikat, dan durasi null', () => {
	const diff = diffWaterfall(rowsA, rowsB);
	assert.equal(diff.length, 5);
	const pairA = diff[0];
	assert.equal(pairA.presence, 'both');
	assert.equal(pairA.url, 'https://example.com/a');
	assert.equal(pairA.statusA, '200');
	assert.equal(pairA.statusB, '404');
	assert.equal(pairA.totalA, 100);
	assert.equal(pairA.totalB, 150);
	assert.equal(pairA.deltaMs, 50);
	const onlyA = diff.filter((d) => d.presence === 'only-a');
	assert.deepEqual(
		onlyA.map((d) => d.url),
		['https://example.com/b', 'https://example.com/d', 'https://example.com/d']
	);
	const onlyB = diff.filter((d) => d.presence === 'only-b');
	assert.equal(onlyB.length, 1);
	assert.equal(onlyB[0].url, 'https://example.com/c');
	assert.equal(onlyB[0].totalB, null);
	assert.equal(onlyB[0].deltaMs, null);
});

test('COMPARE konsol: multiset level+teks, teks sama level berbeda dihitung terpisah', () => {
	const { onlyA, onlyB } = diffConsole(rowsA, rowsB);
	const hello = onlyA.find((e) => e.text === 'hello');
	assert.equal(hello?.level, 'log');
	assert.equal(hello?.countA, 2);
	assert.equal(hello?.countB, 1);
	assert.equal(hello?.extra, 1);
	assert.ok(onlyA.some((e) => e.text === 'lama' && e.level === 'warning'));
	assert.ok(onlyA.some((e) => e.text === 'boom' && e.level === 'exception'));
	assert.deepEqual(
		onlyB.map((e) => e.text),
		['baru']
	);
	const sameText = parseTrace(
		[
			'{"ts":"2026-10-30T03:00:00.000Z","mono_ms":0,"seq":1,"session":"s","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"log","args":["sama"]}}',
			'{"ts":"2026-10-30T03:00:00.100Z","mono_ms":100,"seq":2,"session":"s","lightpanda_version":"1.0.2","type":"Runtime.consoleAPICalled","data":{"type":"error","args":["sama"]}}'
		].join('\n')
	).rows;
	const empty = diffConsole(sameText, sameText);
	assert.equal(empty.onlyA.length, 0);
	assert.equal(empty.onlyB.length, 0);
	const shifted = diffConsole(sameText, parseTrace(TRACE_B).rows);
	assert.ok(shifted.onlyA.some((e) => e.text === 'sama' && e.level === 'error'));
});
