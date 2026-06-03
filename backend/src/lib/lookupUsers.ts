import { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type UserEntry = { id: string; email: string };

/**
 * Resolve a mix of known user IDs and email addresses to UserEntry objects
 * without loading the full user table.
 *
 * - Known user IDs are resolved with individual targeted getUserById calls.
 * - Email addresses are resolved via paginated listUsers with early exit:
 *   pagination stops as soon as every requested email has been found, so
 *   for a small collaborator set this typically reads only one page.
 *
 * Both maps are keyed case-insensitively for emails.
 */
export async function lookupUsers(
    userIds: string[],
    emails: string[],
    db: Db,
): Promise<{ byId: Map<string, UserEntry>; byEmail: Map<string, UserEntry> }> {
    const byId = new Map<string, UserEntry>();
    const byEmail = new Map<string, UserEntry>();

    // Targeted single-user lookups for known IDs
    await Promise.all(
        userIds.map(async (id) => {
            const { data } = await db.auth.admin.getUserById(id);
            const u = data.user;
            if (u?.email) {
                const entry: UserEntry = { id: u.id, email: u.email };
                byId.set(u.id, entry);
                byEmail.set(u.email.toLowerCase(), entry);
            }
        }),
    );

    if (!emails.length) return { byId, byEmail };

    // Resolve remaining emails via paginated scan; stop when all are found
    const needed = new Set(emails.map((e) => e.toLowerCase()));
    for (const found of byEmail.keys()) needed.delete(found);

    let page = 1;
    const PER_PAGE = 50;

    while (needed.size > 0) {
        const { data } = await db.auth.admin.listUsers({ page, perPage: PER_PAGE });
        if (!data?.users?.length) break;

        for (const u of data.users) {
            if (!u.email) continue;
            const lower = u.email.toLowerCase();
            if (needed.has(lower)) {
                const entry: UserEntry = { id: u.id, email: u.email };
                byId.set(u.id, entry);
                byEmail.set(lower, entry);
                needed.delete(lower);
            }
        }

        if (data.users.length < PER_PAGE) break;
        page++;
    }

    return { byId, byEmail };
}
