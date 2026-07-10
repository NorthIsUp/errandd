#!/usr/bin/env bun
/**
 * Migrate routine .md frontmatter to the unified `on:` triggers list.
 * Idempotent — safe to run repeatedly. Run from a errandd workspace (or
 * a routine source repo) to upgrade its job files in place.
 */
import { migrateTriggers } from "../app/migrateTriggers";

const n = await migrateTriggers();
console.log(`Migrated ${n} routine file(s) to the new on:-list trigger format.`);
