import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RegistryProjectsSource } from "../config.js";
import { makeFixture, write, type Fixture } from "../test-support/sourceFixture.js";
import { discoverProjects, parseRepoFrontmatter } from "./registryProjects.js";

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
});

describe("parseRepoFrontmatter", () => {
  it.each([
    ["scalar", "---\nrepo: ~/work/a\n---\n", "~/work/a"],
    ["quoted scalar", '---\nrepo: "/abs/a"\n---\n', "/abs/a"],
    ["scalar with a comment", "---\nrepo: /abs/a # main\n---\n", "/abs/a"],
    ["block list, first entry wins", "---\ncreated: x\nrepo:\n  - ~/work/a\n  - ~/work/b\nrefreshed: y\n---\n", "~/work/a"],
    ["flow list", "---\nrepo: [~/work/a, ~/work/b]\n---\n", "~/work/a"],
    ["BOM and CRLF", "﻿---\r\nrepo: /abs/a\r\n---\r\n", "/abs/a"],
    ["quoted scalar with a comment", '---\nrepo: "~/x" # c\n---\n', "~/x"],
    ["quoted scalar holding a #", '---\nrepo: "~/a #b" # c\n---\n', "~/a #b"],
    ["tab after the key", "---\nrepo:\t~/x\n---\n", "~/x"],
    ["block list after a blank line", "---\nrepo:\n\n  - ~/x\n---\n", "~/x"],
    ["block list item with a comment", "---\nrepo:\n  - '~/x' # main\n---\n", "~/x"],
    ["flow list with a quoted comma", '---\nrepo: [ "~/a,b", ~/c ]\n---\n', "~/a,b"],
    ["flow list with a comment", "---\nrepo: [~/a, ~/b] # both\n---\n", "~/a"],
  ])("reads a %s", (_l, text, want) => {
    expect(parseRepoFrontmatter(text)).toBe(want);
  });

  it.each([
    ["no frontmatter", "repo: /abs/a\n"],
    ["repo in the body only", "---\ntitle: x\n---\nrepo: /abs/a\n"],
    ["unclosed frontmatter", "---\nrepo: /abs/a\n"],
    ["empty block list", "---\nrepo:\nnext: 1\n---\n"],
    ["nested key", "---\nmeta:\n  repo: /abs/a\n---\n"],
    ["unbalanced quote", '---\nrepo: "~/a\n---\n'],
    ["flow list with an unbalanced quote", '---\nrepo: [ "~/a, ~/b ]\n---\n'],
    ["only a comment", "---\nrepo: # none\n---\n"],
  ])("ignores %s", (_l, text) => {
    expect(parseRepoFrontmatter(text)).toBeUndefined();
  });
});

describe("discoverProjects", () => {
  function setup() {
    const f = makeFixture();
    fixtures.push(f);
    const reg = join(f.home, "workspace", "second-brain", "notes");
    const alpha = join(f.home, "work", "alpha");
    const beta = join(f.home, "work", "beta");
    write(join(alpha, "thoughts", "shared", "plan.md"), "alpha plan");
    write(join(beta, "thoughts", "shared", "plan.md"), "beta plan");
    write(join(reg, "projects", "alpha.md"), "---\nrepo:\n  - ~/work/alpha\n---\n# Alpha\n");
    write(join(reg, "projects", "beta.md"), "---\nrepo: ~/work/beta\n---\n");
    write(join(reg, "projects", "wide.md"), "---\nrepo: ~\n---\n");
    write(join(reg, "projects", "rel.md"), "---\nrepo: work/alpha\n---\n");
    write(join(reg, "projects", "no-repo.md"), "---\ntitle: x\n---\n");
    write(join(reg, "..", "inbox", "sneaky.md"), "---\nrepo: ~/work/alpha\n---\n");
    const src = (enabledProjects: string[]): RegistryProjectsSource => ({
      id: "projects",
      kind: "registry_projects",
      enabled: true,
      registry: reg,
      subpath: "thoughts/shared",
      enabledProjects,
    });
    return { f, reg, alpha, src };
  }

  it("lists projects found through repo: frontmatter; only enabled ones get a root", () => {
    const { f, alpha, src } = setup();
    const v = discoverProjects(src(["alpha"]), { exclusion: { home: f.home } });
    expect(v.availability).toBe("ok");
    expect(v.projects).toEqual([
      { name: "alpha", enabled: true, availability: "ok", root: join(alpha, "thoughts", "shared") },
      { name: "beta", enabled: false, availability: "disabled" },
      { name: "rel", enabled: false, availability: "disabled" },
      { name: "wide", enabled: false, availability: "disabled" },
    ]);
  });

  it("marks a repo at ~ too broad, a relative repo invalid, and a missing name not found", () => {
    const { f, src } = setup();
    const v = discoverProjects(src(["wide", "rel", "ghost"]), { exclusion: { home: f.home } });
    const by = Object.fromEntries(v.projects.map((p) => [p.name, p]));
    expect(by.wide).toEqual({ name: "wide", enabled: true, availability: "too-broad" });
    expect(by.rel).toEqual({ name: "rel", enabled: true, availability: "repo-invalid" });
    expect(by.ghost).toEqual({ name: "ghost", enabled: true, availability: "not-found" });
  });

  it("marks an enabled project whose subpath is missing unavailable", () => {
    const { f, src } = setup();
    write(join(f.home, "work", "gamma", "README.md"), "no thoughts dir");
    write(join(f.home, "workspace", "second-brain", "notes", "projects", "gamma.md"), "---\nrepo: ~/work/gamma\n---\n");
    const v = discoverProjects(src(["gamma"]), { exclusion: { home: f.home } });
    expect(v.projects.find((p) => p.name === "gamma")).toEqual({ name: "gamma", enabled: true, availability: "unresolvable" });
  });

  it.each([
    ["~/.ssh", ".ssh"],
    ["~/notes/../.ssh", ".ssh"],
    ["~/code/repo/.git", "code/repo/.git"],
    ["~/work/secrets", "work/secrets"],
    ["~/work/tokens", "work/tokens"],
  ])("refuses a project whose repo is %s", (repo, dir) => {
    const { f, src } = setup();
    write(join(f.home, ...dir.split("/"), "thoughts", "shared", "p.md"), "hidden");
    write(join(f.home, "workspace", "second-brain", "notes", "projects", "evil.md"), `---\nrepo: ${repo}\n---\n`);
    const v = discoverProjects(src(["evil"]), { exclusion: { home: f.home } });
    expect(v.projects.find((p) => p.name === "evil")).toEqual({ name: "evil", enabled: true, availability: "excluded" });
  });

  it("refuses a project inside the private profile store", () => {
    const { f, src } = setup();
    write(join(f.home, "workspace", "personal-context", "thoughts", "shared", "p.md"), "private");
    write(join(f.home, "workspace", "second-brain", "notes", "projects", "personal-context.md"), "---\nrepo: ~/workspace/personal-context\n---\n");
    const v = discoverProjects(src(["personal-context"]), { exclusion: { home: f.home } });
    expect(v.projects.find((p) => p.name === "personal-context")?.availability).toBe("excluded");
  });
});
