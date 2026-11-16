// import { existsSync } from "node:fs";
// import { resolve } from "node:path";
// import { config } from "dotenv";
// import { z } from "zod";
//
// const envPath = resolve(process.cwd(), ".env");
//
// if (!existsSync(envPath)) {
//   throw new Error(`Missing required environment file: ${envPath}`);
// }
//
// const result = config({ path: envPath });
//
// if (result.error) {
//   throw new Error(`Failed to load environment file ${envPath}: ${result.error.message}`);
// }
//
// const envSchema = z.object({
//   API_KEY: z.string().min(1, "API_KEY must not be empty"),
// });
//
// const parsed = envSchema.safeParse(process.env);
//
// if (!parsed.success) {
//   const details = parsed.error.issues
//     .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
//     .join("\n");
//   throw new Error(`Invalid environment variables:\n${details}`);
// }
//
// export const env = parsed.data;
// export type Env = z.infer<typeof envSchema>;
