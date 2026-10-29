const page = new Page();
await page.goto("http://127.0.0.1:8765/ok.html");
const data = page.extract({ title: "title", heading: "h1" });
const t = page.evaluate("document.title");
return { extracted: data, evaluated: t };
