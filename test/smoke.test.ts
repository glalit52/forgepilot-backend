import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

describe("boot", () => {
  it("serves health and the public plan catalogue", async () => {
    const c = h.client();
    expect((await h.server.inject({ url: "/healthz" })).statusCode).toBe(200);
    const plans = await c.get("/plans");
    expect(plans.status).toBe(200);
    expect(plans.body.length).toBe(6);
  });
  it("signs a demo persona in", async () => {
    const c = h.client();
    const personas = await c.get("/session/personas");
    expect(personas.body.length).toBeGreaterThan(4);
    const info = await c.signInAs("u_maya");
    expect(info.user.name).toBe("Maya Chen");
    expect(info.workspace.id).toBe("ws_lumen");
  });
});
