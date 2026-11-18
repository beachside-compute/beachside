import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/grants/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  driver: "durable-sqlite",
});
