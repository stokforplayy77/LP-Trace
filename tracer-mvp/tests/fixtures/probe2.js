const page = new Page();
await page.goto("http://127.0.0.1:8765/missing.html");
let heading = null;
let err = null;
try {
  const data = page.extract({ heading: "h1" });
  heading = data.heading;
} catch (e) {
  err = String(e && e.message ? e.message : e);
}
return { heading: heading, error: err };
