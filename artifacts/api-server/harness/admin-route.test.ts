/** Bare Admin Console requests must never fall through to the public landing page. */
process.env.NODE_ENV = "test";
process.env.PORT = "8080";
process.env.BASE_PATH = "/app";
process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:5432/unused";
process.env.SESSION_SECRET = "admin-route-harness-session-secret";
process.env.CREDENTIALS_ENCRYPTION_KEY = "0".repeat(64);

const [{ default: app }, { pool }] = await Promise.all([
  import("../src/app"),
  import("@workspace/db"),
]);

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve, reject) => {
  server.once("listening", resolve);
  server.once("error", reject);
});

let failures = 0;
function expect(name: string, condition: boolean, detail = "") {
  if (!condition) failures += 1;
  console.log(
    `${condition ? "✓" : "✗ FAIL"}  ${name}${condition ? "" : `  ${detail}`}`,
  );
}

try {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Admin route harness did not receive a TCP address");
  }
  const response = await fetch(`http://127.0.0.1:${address.port}/admin`, {
    headers: { Accept: "text/html" },
    redirect: "manual",
  });
  expect(
    "bare /admin uses a temporary canonical redirect",
    response.status === 307,
    `received ${response.status}`,
  );
  expect(
    "bare /admin redirects to the Admin bundle root",
    response.headers.get("location") === "/admin/",
    `received ${response.headers.get("location")}`,
  );
  expect(
    "Admin redirect is not cached as landing content",
    response.headers.get("cache-control")?.includes("no-store") === true,
    `received ${response.headers.get("cache-control")}`,
  );
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await pool.end();
}

if (failures > 0) process.exit(1);
console.log("admin-route: canonical Admin Console entry verified");
