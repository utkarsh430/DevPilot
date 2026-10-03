import { describe, expect, it } from "vitest";
import {
  OLDEST_TENANT_SQL,
  OWNER_TENANT_FOR_EMAIL_SQL,
  adminCreateUserRequest,
  classifyOperator,
  interpretAdminCreateUser,
  isValidEmail,
} from "@/lib/dev/tenant-bootstrap";

describe("adminCreateUserRequest", () => {
  it("POSTs to /auth/v1/admin/users with apikey + Bearer and a confirmed email", () => {
    const { url, init } = adminCreateUserRequest(
      "http://127.0.0.1:54321/",
      "sb_secret_x",
      "  Me@Example.com ",
    );
    expect(url).toBe("http://127.0.0.1:54321/auth/v1/admin/users");
    expect(init.method).toBe("POST");
    expect(init.headers.apikey).toBe("sb_secret_x");
    expect(init.headers.Authorization).toBe("Bearer sb_secret_x");
    expect(JSON.parse(init.body)).toEqual({ email: "Me@Example.com", email_confirm: true });
  });
});

describe("interpretAdminCreateUser", () => {
  it("200/201 → created", () => {
    expect(interpretAdminCreateUser(200, { id: "u" })).toBe("created");
    expect(interpretAdminCreateUser(201, { id: "u" })).toBe("created");
  });

  it("422 with GoTrue's already-registered shape → exists (a re-run)", () => {
    expect(
      interpretAdminCreateUser(422, {
        code: 422,
        error_code: "email_exists",
        msg: "A user with this email address has already been registered",
      }),
    ).toBe("exists");
    expect(interpretAdminCreateUser(422, { msg: "User already exists" })).toBe("exists");
  });

  it("any other failure carries the body, not just the status", () => {
    const out = interpretAdminCreateUser(500, { msg: "Database error finding user" });
    expect(out).toEqual({
      error: expect.stringContaining("HTTP 500: Database error finding user"),
    });
    const other422 = interpretAdminCreateUser(422, { msg: "Unable to validate email address" });
    expect(other422).toEqual({ error: expect.stringContaining("Unable to validate") });
  });
});

describe("classifyOperator", () => {
  const mine = { id: "b", name: "me@example.com" };

  it("same tenant → operator", () => {
    expect(classifyOperator({ id: "b", name: "me@example.com" }, mine).operator).toBe(true);
  });

  it("no other tenant → operator", () => {
    expect(classifyOperator(null, mine).operator).toBe(true);
  });

  it("an older tenant → not operator, and the reason names it", () => {
    const out = classifyOperator({ id: "a", name: "Harbour Lights Co" }, mine);
    expect(out.operator).toBe(false);
    expect(out.reason).toContain("Harbour Lights Co");
    expect(out.reason).toContain("Settings → Setup");
  });
});

describe("the SQL", () => {
  it("resolves the owner tenant by email, owner/admin only, oldest tenant first", () => {
    expect(OWNER_TENANT_FOR_EMAIL_SQL).toMatch(/lower\(u\.email\)\s*=\s*lower\(\$1\)/);
    expect(OWNER_TENANT_FOR_EMAIL_SQL).toMatch(/m\.role in \('owner', 'admin'\)/);
    expect(OWNER_TENANT_FOR_EMAIL_SQL).toMatch(/order by t\.created_at asc/);
    expect(OWNER_TENANT_FOR_EMAIL_SQL).toMatch(/limit 1/);
  });

  it("the oldest-tenant query is the operator rule's own ordering", () => {
    expect(OLDEST_TENANT_SQL).toMatch(/from public\.tenants\s+order by created_at asc\s+limit 1/);
  });
});

describe("isValidEmail", () => {
  it("accepts the ordinary shape and rejects the obvious non-emails", () => {
    expect(isValidEmail("me@example.com")).toBe(true);
    expect(isValidEmail(" me@example.com ")).toBe(true);
    expect(isValidEmail("me@example")).toBe(false);
    expect(isValidEmail("me example.com")).toBe(false);
    expect(isValidEmail("")).toBe(false);
  });
});
