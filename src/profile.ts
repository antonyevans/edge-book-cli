// Two-tier profile projection (spec-098 lineage, friend-profiles v0.8.0).
// defaultProfile is PURE — it migrates legacy owner_label fields on read and
// must never persist (no write-on-read).
import type { FieldVisibility, IdentityProfile, LocalIdentity, SocialLink } from "./types.ts";

// Resolve the effective profile for an identity, migrating legacy
// owner_label/share_owner_label when identity.profile is absent. Pure: callers
// persist the result via setProfile when the user next edits (no write-on-read).
export function defaultProfile(identity: LocalIdentity): IdentityProfile {
  if (identity.profile) return identity.profile;
  const visibility: Record<string, FieldVisibility> = {
    // Migration (apply-new-default-to-all): legacy share on => name public;
    // legacy share off/absent => name resolves to the new default "friends".
    name: identity.share_owner_label ? "public" : "friends",
  };
  return {
    name: identity.owner_label || undefined,
    visibility,
    profile_version: 1,
  };
}

export function resolveFieldVisibility(profile: IdentityProfile, field: string): FieldVisibility {
  return profile.visibility?.[field] ?? "friends";
}

export function resolveSocialVisibility(profile: IdentityProfile, label: string): FieldVisibility {
  return profile.visibility?.[label] ?? profile.visibility?.["*"] ?? "friends";
}

// Project the visible profile fields for a given inclusion predicate. Shared by
// buildCard (predicate: public-only) and buildFriendProfile (predicate: friends+public).
export function projectProfileFields(
  profile: IdentityProfile,
  includeField: (vis: FieldVisibility) => boolean,
): { name?: string; bio?: string; location?: string; socials?: SocialLink[] } {
  const out: { name?: string; bio?: string; location?: string; socials?: SocialLink[] } = {};
  if (profile.name && includeField(resolveFieldVisibility(profile, "name"))) out.name = profile.name;
  if (profile.bio && includeField(resolveFieldVisibility(profile, "bio"))) out.bio = profile.bio;
  if (profile.location && includeField(resolveFieldVisibility(profile, "location"))) out.location = profile.location;
  const socials = (profile.socials ?? []).filter((s) => includeField(resolveSocialVisibility(profile, s.label)));
  if (socials.length) out.socials = socials;
  return out;
}
