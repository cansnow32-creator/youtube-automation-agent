# Multi-channel isolation boundary

## Current PR scope

This branch is a single-channel workspace implementation. The current schema has one implicit `channel_profiles.id = 'default'` profile. Production, publish schedule, readiness, content ideas, and related learning rows do not carry a channel-profile foreign key. In particular, `getPublishQueue()` and `getLatestReadinessRun()` read workspace-wide rows.

Therefore this branch must not be presented as safe for two channel profiles sharing one AgentTube SQLite database. A shared database could mix queue items, readiness results, ideas, and learning evidence across channels. The YouTube credential used by the publisher is also a single active credential, not selected from a per-channel schedule binding.

## Safe operating boundary until channel scoping is implemented

- Use one isolated AgentTube database/runtime per YouTube channel.
- Bind that runtime to exactly one YouTube OAuth credential/channel.
- Do not import both channels' production or analytics records into the same AgentTube database.
- Do not use a shared AgentTube database as the persistence layer for a multi-profile ChannelStudio workspace.
- Keep channel-specific analytics and learning isolated; never infer channel identity from titles or other user-editable metadata.

## Required future multi-channel migration

A real multi-channel implementation needs a stable `channel_profile_id` on productions, schedules, readiness runs, ideas, analytics snapshots/reports, learning recommendations, and operator runs; scoped unique indexes and queries; profile-bound OAuth credential selection; and migrations that assign legacy rows to one explicitly selected profile. Upload claims and reconciliation must verify both the schedule's profile and the authenticated YouTube channel. This should be delivered with migration, cross-profile denial tests, and rollback coverage before shared-database operation is enabled.

This document records a safety boundary, not a claim that multi-channel support is implemented.
