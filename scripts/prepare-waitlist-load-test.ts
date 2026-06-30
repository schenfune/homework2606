import { mkdir, readFile, writeFile } from "node:fs/promises";
import { prisma } from "../lib/db/prisma";
import { redis } from "../lib/db/redis";

const artifactDir = "artifacts";
const sourcePath = process.env.LOAD_TARGET_FILE || `${artifactDir}/load-test-target.json`;
const outputPath =
  process.env.WAITLIST_TARGET_FILE || `${artifactDir}/load-test-waitlist-target.json`;

type LoadStudent = {
  studentNo: string;
  email: string;
  password: string;
  cookie: string;
};

type LoadTarget = {
  generatedAt?: string;
  courseNo: string;
  courseName: string;
  offeringId: string;
  classNo: string;
  capacity: number;
  studentCount: number;
  password: string;
  students: LoadStudent[];
};

type ReservationSnapshot = {
  profileId?: string;
  status?: string;
  kind?: string;
};

async function main() {
  const target = JSON.parse(await readFile(sourcePath, "utf8")) as LoadTarget;
  const reservations = await loadOfferingReservations(target.offeringId);
  const occupiedProfileIds = Array.from(
    new Set(
      reservations
        .filter((reservation) => reservation.status && reservation.status !== "FAILED")
        .map((reservation) => reservation.profileId)
        .filter((profileId): profileId is string => Boolean(profileId)),
    ),
  );
  const occupiedProfiles =
    occupiedProfileIds.length > 0
      ? await prisma.studentProfile.findMany({
          where: {
            id: {
              in: occupiedProfileIds,
            },
          },
          select: {
            studentNo: true,
          },
        })
      : [];
  const occupiedStudentNos = new Set(occupiedProfiles.map((profile) => profile.studentNo));
  const waitlistStudents = target.students.filter(
    (student) => !occupiedStudentNos.has(student.studentNo),
  );
  const activeReservations = reservations.filter(
    (reservation) => reservation.kind === "ACTIVE" && reservation.status !== "FAILED",
  ).length;
  const waitlistReservations = reservations.filter(
    (reservation) => reservation.kind === "WAITLIST" && reservation.status !== "FAILED",
  ).length;

  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        ...target,
        generatedAt: new Date().toISOString(),
        mode: "waitlist",
        sourceTarget: sourcePath,
        studentCount: waitlistStudents.length,
        students: waitlistStudents,
        excluded: {
          activeReservations,
          waitlistReservations,
          existingReservations: occupiedStudentNos.size,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log("候补压测目标已准备");
  console.log(`课程: ${target.courseNo} ${target.courseName}`);
  console.log(`正式预占/登记: ${activeReservations}`);
  console.log(`已有候补预占/登记: ${waitlistReservations}`);
  console.log(`候补学生数: ${waitlistStudents.length}`);
  console.log(`目标文件: ${outputPath}`);
}

async function loadOfferingReservations(offeringId: string) {
  const keys = await redis.keys(`enrollment:reservation:*:${offeringId}`);
  const reservations: ReservationSnapshot[] = [];

  for (const key of keys) {
    reservations.push(await redis.hGetAll(key));
  }

  return reservations;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();

    if (redis.isOpen) {
      await redis.quit();
    }
  });
