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

// 根据抢课后的Redis预占结果生成候补压测目标文件。
async function main() {
  // 主压测目标文件中包含压测课程和全部压测学生。
  const target = JSON.parse(await readFile(sourcePath, "utf8")) as LoadTarget;
  const reservations = await loadOfferingReservations(target.offeringId);
  // 已经正式预占或候补的学生不能再作为候补压测目标。
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
  // 候补压测只使用未抢到正式名额的学生。
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
  // 输出新的目标文件，k6 waitlist模式会读取这个文件。
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

// 读取某个开课班下所有Redis预占记录。
async function loadOfferingReservations(offeringId: string) {
  const keys = await redis.keys(`enrollment:reservation:*:${offeringId}`);
  const reservations: ReservationSnapshot[] = [];

  for (const key of keys) {
    // 每条reservation是Redis hash，包含profileId、kind和status等字段。
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
