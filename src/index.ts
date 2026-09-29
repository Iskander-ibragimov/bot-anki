import type { Env } from "./env";

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response("ok");
  },
} satisfies ExportedHandler<Env>;
