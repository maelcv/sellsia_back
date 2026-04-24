import { prisma } from './src/prisma.js';
async function run() {
  try {
    const projects = await prisma.project.findMany();
    console.log("Success! Found", projects.length, "projects.");
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await prisma.$disconnect();
  }
}
run();
