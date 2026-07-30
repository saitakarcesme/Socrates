import { seedDevelopmentData } from "./development-seed";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error("DATABASE_URL is required to seed development data.");
}

await seedDevelopmentData(connectionString);
console.log("Socrates development workspace seeded.");
