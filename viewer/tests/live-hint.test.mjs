// tests/live-hint.test.mjs — Uji liveFailureHint (node:test, tanpa browser).
import test from "node:test";
import assert from "node:assert/strict";
import { liveFailureHint } from "../src/lib/live-hint.ts";

test("origin publik + SSE loopback -> panduan PNA", () => {
  const h = liveFailureHint("139.162.21.81", "http://127.0.0.1:9229/events");
  assert.match(h, /Private Network Access/);
  assert.match(h, /localhost:8103/);
});

test("origin localhost + SSE loopback -> panduan generik", () => {
  const h = liveFailureHint("localhost", "http://127.0.0.1:9229/events");
  assert.match(h, /tracer masih jalan/);
  assert.doesNotMatch(h, /Private Network Access/);
});

test("origin file:// (hostname kosong) + SSE loopback -> panduan generik", () => {
  const h = liveFailureHint("", "http://127.0.0.1:9229/events");
  assert.doesNotMatch(h, /Private Network Access/);
});

test("origin publik + SSE non-loopback -> panduan generik", () => {
  const h = liveFailureHint("139.162.21.81", "http://10.0.0.5:9229/events");
  assert.doesNotMatch(h, /Private Network Access/);
});

test("URL SSE tidak valid -> panduan URL", () => {
  assert.match(liveFailureHint("localhost", "bukan-url"), /URL SSE live/);
});
