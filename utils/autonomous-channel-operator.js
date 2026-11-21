const { randomUUID } = require('crypto');
const { Logger } = require('./logger');
const { requireApprovedVideoConcept } = require('./approved-video-concept-gate');

class AutonomousChannelOperator {
  constructor(db, options = {}) {
    this.db = db;
    this.researchAndPlan = options.researchAndPlan;
    this.startGenerationJob = options.startGenerationJob;
    this.resumeGenerationJob = options.resumeGenerationJob;
    this.waitForGenerationJob = options.waitForGenerationJob;
    this.notify = options.notify || (async () => null);
    this.logger = new Logger('AutonomousOperator');
    this.activeRuns = new Map();
    this.runLeases = new Map();
    this.operatorLockId = 'operator:active';
    this.operatorLeaseMs = 60 * 1000;
  }

  async acquireOperatorLease() {
    const owner = randomUUID();
    const acquired = await this.db.acquireProductionOperationLock(
      this.operatorLockId, owner, this.operatorLeaseMs
    );
    if (!acquired) {
      const error = new Error('Another application process currently owns the autonomous operator');
      error.status = 409;
      error.code = 'OPERATOR_LEASE_ACTIVE';
      throw error;
    }
    const lease = { productionId: this.operatorLockId, owner, timer: null, lost: false };
    lease.timer = setInterval(async () => {
      try {
        const ok = await this.db.renewProductionOperationLock(
          this.operatorLockId, lease.owner, this.operatorLeaseMs
        );
        if (!ok) lease.lost = true;
      } catch (_error) {
        lease.lost = true;
      }
    }, 15000);
    lease.timer.unref?.();
    return lease;
  }

  async releaseOperatorLease(runId, lease) {
    if (lease.timer) clearInterval(lease.timer);
    this.runLeases.delete(runId);
    await this.db.releaseProductionOperationLock(this.operatorLockId, lease.owner);
  }

  async assertOperatorLease(runId) {
    const lease = this.runLeases.get(runId);
    if (!lease || lease.lost) {
      const error = new Error('Autonomous operator lease was lost');
      error.code = 'OPERATOR_LEASE_LOST';
      error.status = 409;
      throw error;
    }
    const renewed = await this.db.renewProductionOperationLock(
      this.operatorLockId, lease.owner, this.operatorLeaseMs
    );
    if (!renewed) {
      lease.lost = true;
      const error = new Error('Autonomous operator lease was lost');
      error.code = 'OPERATOR_LEASE_LOST';
      error.status = 409;
      throw error;
    }

  }

  async bindApprovedConcept(strategy) {
    const concepts = await this.db.listVideoConcepts(100);
    const selected = strategy?.approvedVideoConceptId
      ? strategy.approvedVideoConceptId
      : Array.isArray(concepts) ? concepts.find(item => item?.status === 'approved')?.id : null;
    const approved = await requireApprovedVideoConcept(this.db, selected);
    return {
      ...strategy,
      approvedVideoConcept: approved.concept,
      approvedVideoConceptId: approved.id
    };
  }

  async start(strategy) {
    if (!strategy || strategy.status !== 'active') {
      const error = new Error('Save and activate a channel strategy before starting the autonomous operator');
      error.status = 409;
      throw error;
    }
    strategy = await this.bindApprovedConcept(strategy);
    const lease = await this.acquireOperatorLease();
    let run;
    try {
      const active = await this.db.getActiveOperatorRun();
      if (active || this.activeRuns.size) {
        const error = new Error('An autonomous operator run is already active');
        error.status = 409;
        throw error;
      }
      run = await this.db.createOperatorRun(strategy.id);
      this.runLeases.set(run.id, lease);
      const work = this.execute(run.id, strategy)
        .catch(error => this.logger.error(`Operator run ${run.id} failed:`, error))
        .finally(async () => {
          this.activeRuns.delete(run.id);
          await this.releaseOperatorLease(run.id, lease);
        });
      this.activeRuns.set(run.id, work);
      return run;
    } catch (error) {
      if (lease.timer) clearInterval(lease.timer);
      if (run) this.runLeases.delete(run.id);
      await this.db.releaseProductionOperationLock(this.operatorLockId, lease.owner);
      throw error;
    }
  }

  async resume(runId, strategy) {
    const run = await this.db.getOperatorRun(runId);
    if (!run) {
      const error = new Error('Operator run not found');
      error.status = 404;
      throw error;
    }
    if (!['failed', 'interrupted', 'completed_with_issues'].includes(run.status)) {
      const error = new Error('Only failed or interrupted operator runs can be resumed');
      error.status = 409;
      throw error;
    }
    if (!strategy || strategy.status !== 'active') {
      const error = new Error('Activate the saved channel strategy before resuming this run');
      error.status = 409;
      throw error;
    }
    strategy = await this.bindApprovedConcept(strategy);
    const lease = await this.acquireOperatorLease();
    try {
      const active = await this.db.getActiveOperatorRun();
      if (active || this.activeRuns.size) {
        const error = new Error('An autonomous operator run is already active');
        error.status = 409;
        throw error;
      }
      this.runLeases.set(runId, lease);
      await this.update(runId, {
        status: 'queued',
        stage: 'resuming',
        error: null,
        cancelRequested: false,
        completedAt: null
      });
      const work = this.execute(runId, strategy, { resume: true })
        .catch(error => this.logger.error(`Resumed operator run ${runId} failed:`, error))
        .finally(async () => {
          this.activeRuns.delete(runId);
          await this.releaseOperatorLease(runId, lease);
        });
      this.activeRuns.set(runId, work);
      return this.db.getOperatorRun(runId);
    } catch (error) {
      if (lease.timer) clearInterval(lease.timer);
      this.runLeases.delete(runId);
      await this.db.releaseProductionOperationLock(this.operatorLockId, lease.owner);
      throw error;
    }
  }

  async execute(runId, strategy, options = {}) {
    try {
      const stored = options.resume ? await this.db.getOperatorRun(runId) : null;
      let research = stored?.research || {};
      let plan = stored?.plan || [];
      const generatedJobs = stored?.generatedJobs || [];
      await this.update(runId, {
        status: 'running',
        stage: plan.length ? 'resuming_plan' : 'researching',
        progress: plan.length ? Math.max(20, stored?.progress || 20) : 5,
        error: null,
        cancelRequested: false,
        completedAt: null
      });
      if (!plan.length) {
        ({ research, plan } = await this.researchAndPlan(strategy));
      }
      if (!plan.length) throw new Error('Research did not produce any usable content ideas');
      await this.assertNotCancelled(runId);
      await this.update(runId, { stage: 'planning', progress: 20, research, plan });

      for (let index = 0; index < plan.length; index++) {
        await this.assertNotCancelled(runId);
        const item = plan[index];
        let record = generatedJobs[index];
        if (record?.status === 'completed') continue;
        let ideaId = record?.ideaId;
        if (!record) {
          const existingIdeas = this.db.listContentIdeas ? await this.db.listContentIdeas() : [];
          const normalizedTopic = String(item.topic || '').trim().toLowerCase();
          const backlogIdea = existingIdeas.find(idea =>
            idea.status === 'backlog' && String(idea.topic || '').trim().toLowerCase() === normalizedTopic
          );
          const idea = backlogIdea || await this.db.createContentIdea({
            topic: item.topic,
            angle: item.angle,
            style: item.format,
            status: 'generating',
            rationale: item.rationale
          });
          ideaId = idea.id;
          if (backlogIdea) {
            await this.db.updateContentIdea(ideaId, { status: 'generating' });
          }
          record = { jobId: null, ideaId, topic: item.topic, status: 'queued', planIndex: index };
          generatedJobs[index] = record;
        } else if (ideaId) {
          await this.db.updateContentIdea(ideaId, { status: 'generating' });
        }
        const progress = 20 + Math.round((index / plan.length) * 70);
        await this.update(runId, {
          stage: `producing_${index + 1}_of_${plan.length}`,
          progress,
          generatedJobs
        });

        try {
          await this.update(runId, { generatedJobs });
          await this.assertNotCancelled(runId);
          let job = record.jobId ? await this.db.getGenerationJob(record.jobId) : null;
          if (job && ['failed', 'interrupted'].includes(job.status)) {
            job = await this.resumeGenerationJob(job.id);
          } else if (!job || !['queued', 'running', 'completed'].includes(job.status)) {
            const selectedSourceUrls = new Set(item.sourceUrls || []);
            job = await this.startGenerationJob({
              topic: item.topic,
              style: item.format,
              length: item.length,
              source: 'autonomous_operator',
              strategyContext: {
                angle: item.angle,
                rationale: item.rationale,
                pillar: item.pillar,
                audience: strategy.audience,
                objective: strategy.objective,
                valueProposition: strategy.value_proposition,
                constraints: strategy.constraints,
                approvedVideoConcept: strategy.approvedVideoConcept || null,
                approvedVideoConceptId: strategy.approvedVideoConceptId || null,
                researchSources: (research.sourceCatalog || []).filter(source => selectedSourceUrls.has(source.url))
              }
            });
          }
          record.jobId = job.id;
          record.status = 'running';
          await this.update(runId, { generatedJobs });
          const completed = job.status === 'completed' ? job : await this.waitForGenerationJob(job.id);
          record.status = completed.status;
          record.productionId = completed.production_id || null;
          record.reviewStatus = completed.details?.reviewStatus || null;
          record.error = completed.error || null;
          if (ideaId) {
            await this.db.updateContentIdea(ideaId, {
              status: completed.status === 'completed' ? 'generated' : 'failed'
            });
            if (completed.status === 'completed' && completed.production_id && this.db.linkContentIdeaToProduction) {
              await this.db.linkContentIdeaToProduction(ideaId, completed.production_id);
            }
          }
        } catch (error) {
          record.status = error.code === 'OPERATOR_CANCELLED' ? 'cancelled' : 'failed';
          record.error = error.message;
          if (ideaId) await this.db.updateContentIdea(ideaId, { status: 'failed' });
          if (error.code === 'OPERATOR_CANCELLED') throw error;
        }
        await this.update(runId, {
          progress: 20 + Math.round(((index + 1) / plan.length) * 70),
          generatedJobs
        });
      }

      const completed = generatedJobs.filter(job => job.status === 'completed');
      const needsReview = completed.filter(job => ['needs_review', 'needs_attention'].includes(job.reviewStatus));
      const failed = generatedJobs.filter(job => job.status !== 'completed');
      const allFailed = completed.length === 0 && failed.length > 0;
      const status = allFailed ? 'failed' : needsReview.length ? 'waiting_review' : failed.length ? 'completed_with_issues' : 'completed';
      const summary = {
        planned: plan.length,
        generated: completed.length,
        needsReview: needsReview.length,
        failed: failed.length
      };
      await this.update(runId, {
        status,
        stage: allFailed ? 'failed' : needsReview.length ? 'waiting_for_review' : 'complete',
        progress: 100,
        generatedJobs,
        summary,
        error: allFailed ? 'Every planned video failed during generation' : null,
        completedAt: new Date().toISOString()
      });
      await this.notify({
        type: 'autonomous_run_complete',
        level: failed.length ? 'warning' : 'success',
        title: needsReview.length ? 'Autonomous plan is ready for review' : 'Autonomous plan completed',
        message: `${completed.length} of ${plan.length} planned videos finished production.`,
        data: { runId, ...summary }
      });
    } catch (error) {
      const cancelled = error.code === 'OPERATOR_CANCELLED';
      await this.update(runId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? 'cancelled' : 'failed',
        error: error.message,
        completedAt: new Date().toISOString()
      });
      if (!cancelled) {
        await this.notify({
          type: 'autonomous_run_failure',
          level: 'error',
          title: 'Autonomous channel run failed',
          message: error.message,
          data: { runId }
        });
      }
      throw error;
    }
  }

  async cancel(runId) {
    const run = await this.db.getOperatorRun(runId);
    if (!run) return null;
    if (!['queued', 'running', 'cancelling'].includes(run.status)) return run;
    for (const item of run.generatedJobs) {
      const job = await this.db.getGenerationJob(item.jobId);
      if (job && ['queued', 'running'].includes(job.status)) {
        await this.db.updateGenerationJob(job.id, {
          cancelRequested: true,
          details: { cancelReason: 'Autonomous operator stopped by the channel owner' }
        });
      }
    }
    return this.update(runId, { status: 'cancelling', cancelRequested: true });
  }

  async assertNotCancelled(runId) {
    await this.assertOperatorLease(runId);
    const run = await this.db.getOperatorRun(runId);
    if (run?.cancelRequested) {
      const error = new Error('Autonomous operator stopped by the channel owner');
      error.code = 'OPERATOR_CANCELLED';
      throw error;
    }
  }

  update(runId, changes) {
    const lease = this.runLeases.get(runId) || null;
    return this.db.updateOperatorRun(runId, changes, lease);
  }
}

module.exports = { AutonomousChannelOperator };
