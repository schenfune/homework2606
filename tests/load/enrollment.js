import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 100,
  duration: "30s",
  thresholds: {
    http_req_failed: ["rate<0.20"],
    http_req_duration: ["p(95)<1000"],
  },
};

const baseUrl = __ENV.BASE_URL || "http://host.docker.internal:3000";
const offeringId = __ENV.OFFERING_ID;
const cookie = __ENV.SESSION_COOKIE;

export default function enrollmentLoadTest() {
  const response = http.post(
    `${baseUrl}/api/student/enrollments`,
    JSON.stringify({ offeringId }),
    {
      headers: {
        "content-type": "application/json",
        cookie,
      },
    },
  );

  check(response, {
    "request finished": (res) => [200, 400, 403, 429].includes(res.status),
  });

  sleep(1);
}
