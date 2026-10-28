// A small in-process job queue: async job handlers run with limited concurrency, so a burst of
// photo uploads cannot each spawn unbounded remote-model calls at once. Pluggable on purpose -
// createQueue() is the only thing server/routes/pipeline.js touches, so a real Cloud Tasks (or
// similar) driver can replace the in-process one later with no change at the call site.
function createQueue(options) {
  const concurrency = Math.max(1, Number(options.concurrency) || 1);
  const handler = options.handler; // async (id, payload, report) => void
  const onStatus = options.onStatus || function () {};
  const queue = [];
  let active = 0;

  function report(id, patch) {
    return Promise.resolve(onStatus(id, patch)).catch(function () {});
  }

  function runNext() {
    if (active >= concurrency || queue.length === 0) {
      return;
    }
    const job = queue.shift();
    active += 1;
    report(job.id, { status: "running", startedAt: Date.now() })
      .then(function () {
        return handler(job.id, job.payload, function (patch) {
          return report(job.id, patch);
        });
      })
      .catch(function (error) {
        return report(job.id, {
          status: "failed",
          error: (error && error.message) || "The pipeline failed.",
          finishedAt: Date.now(),
        });
      })
      .then(function () {
        active -= 1;
        runNext();
      });
  }

  function enqueue(id, payload) {
    queue.push({ id: id, payload: payload });
    report(id, { status: "queued" });
    runNext();
  }

  return { enqueue: enqueue };
}

module.exports = { createQueue: createQueue };
