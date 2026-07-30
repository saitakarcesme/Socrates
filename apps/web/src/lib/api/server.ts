import { createControlPlaneClient } from "./client";

export function createServerControlPlaneClient() {
  return createControlPlaneClient({
    baseUrl: process.env.SOCRATES_API_URL ?? "http://127.0.0.1:3001",
  });
}
