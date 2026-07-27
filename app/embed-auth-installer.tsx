"use client";

import { installEmbedAuthFetch } from "@/lib/embed-auth";

// Patch fetch at module-evaluation time — before any component effect issues an
// API call — so every existing fetch("/api/…") call site picks up the embed
// bearer token without being edited. No-op outside the browser and when no
// token is stashed (standalone cookie sessions).
installEmbedAuthFetch();

export default function EmbedAuthInstaller() {
  return null;
}
