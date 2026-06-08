#!/usr/bin/env python3
"""Print unresolved GitHub pull request review threads.

The frontend PR gate uses this to surface actionable Codex review threads with
stable thread ids and comment URLs so an agent can reply in the right thread.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import textwrap
from typing import Any

CODEX_LOGIN = "chatgpt-codex-connector"


def run_gh(args: list[str]) -> str:
    result = subprocess.run(
        ["gh", *args],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    return result.stdout


def gh_json(args: list[str]) -> Any:
    return json.loads(run_gh(args))


def repo_parts(repo: str | None) -> tuple[str, str]:
    if repo:
        owner, name = repo.split("/", 1)
        return owner, name
    data = gh_json(["repo", "view", "--json", "owner,name"])
    return data["owner"]["login"], data["name"]


def current_pr_number() -> int:
    data = gh_json(["pr", "view", "--json", "number"])
    return int(data["number"])


def fetch_threads(owner: str, repo: str, number: int) -> dict[str, Any]:
    query = """
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          number
          url
          reviewThreads(first: 100) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              comments(first: 20) {
                nodes {
                  id
                  url
                  author { login }
                  body
                  createdAt
                }
              }
            }
          }
        }
      }
    }
    """
    return gh_json(
        [
            "api",
            "graphql",
            "-f",
            f"query={query}",
            "-f",
            f"owner={owner}",
            "-f",
            f"repo={repo}",
            "-F",
            f"number={number}",
        ]
    )


def has_codex_comment(thread: dict[str, Any]) -> bool:
    return any(
        comment.get("author", {}).get("login") == CODEX_LOGIN
        for comment in thread["comments"]["nodes"]
    )


def thread_url(thread: dict[str, Any]) -> str | None:
    comments = thread["comments"]["nodes"]
    return comments[-1]["url"] if comments else None


def filtered_threads(args: argparse.Namespace) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    owner, repo = repo_parts(args.repo)
    number = args.pr or current_pr_number()
    data = fetch_threads(owner, repo, number)
    pull_request = data["data"]["repository"]["pullRequest"]
    threads = pull_request["reviewThreads"]["nodes"]

    selected = []
    for thread in threads:
        if not args.include_resolved and thread["isResolved"]:
            continue
        if args.actionable_only and thread["isOutdated"]:
            continue
        if args.codex_only and not has_codex_comment(thread):
            continue
        selected.append(thread)
    return pull_request, selected


def print_human(pull_request: dict[str, Any], threads: list[dict[str, Any]]) -> None:
    print(f"PR #{pull_request['number']}: {pull_request['url']}")
    if not threads:
        print("No matching review threads.")
        return

    for thread in threads:
        print()
        print(
            f"Thread {thread['id']} "
            f"resolved={thread['isResolved']} outdated={thread['isOutdated']} "
            f"path={thread['path']} line={thread['line']}"
        )
        url = thread_url(thread)
        if url:
            print(f"URL: {url}")
        for comment in thread["comments"]["nodes"]:
            author = comment.get("author", {}).get("login") or "unknown"
            body = textwrap.indent(comment["body"].strip(), "    ")
            print(f"- {author} at {comment['createdAt']} ({comment['id']}):")
            print(body)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pr", nargs="?", type=int, help="PR number; defaults to current branch PR")
    parser.add_argument("--repo", help="GitHub repo as OWNER/REPO; defaults to gh current repo")
    parser.add_argument("--json", action="store_true", help="Print JSON instead of human text")
    parser.add_argument("--include-resolved", action="store_true", help="Include resolved threads")
    parser.add_argument("--codex-only", action="store_true", help="Only show threads with Codex comments")
    parser.add_argument(
        "--actionable-only",
        action="store_true",
        help="Exclude outdated threads, leaving unresolved current-diff threads",
    )
    parser.add_argument("--exit-code", action="store_true", help="Exit 1 if any matching thread exists")
    args = parser.parse_args()

    pull_request, threads = filtered_threads(args)
    if args.json:
        print(
            json.dumps(
                {
                    "pull_request": {
                        "number": pull_request["number"],
                        "url": pull_request["url"],
                    },
                    "threads": threads,
                },
                indent=2,
            )
        )
    else:
        print_human(pull_request, threads)

    return 1 if args.exit_code and threads else 0


if __name__ == "__main__":
    raise SystemExit(main())
