// Package gittestenv makes git subprocesses started by tests deterministic.
//
// It is intended to be called from TestMain. A git fetch (or commit) normally
// ends with "git maintenance run --auto --detach", which can start a detached
// gc that keeps writing into .git/objects after the command returned. That
// races with t.TempDir cleanup ("unlinkat ...: directory not empty") and makes
// tests flaky (ISSUE-074). Configuration is passed through the environment so
// it also applies to git run by the code under test.
package gittestenv

import (
	"os"
	"strconv"
)

var settings = [][2]string{
	{"gc.auto", "0"},
	{"gc.autoDetach", "false"},
	{"maintenance.auto", "false"},
	{"fetch.writeCommitGraph", "false"},
}

// Apply appends the settings to GIT_CONFIG_COUNT/KEY/VALUE in this process's
// environment once.
func Apply() {
	count := 0
	if raw := os.Getenv("GIT_CONFIG_COUNT"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
			count = parsed
		}
	}
	for _, setting := range settings {
		os.Setenv("GIT_CONFIG_KEY_"+strconv.Itoa(count), setting[0])
		os.Setenv("GIT_CONFIG_VALUE_"+strconv.Itoa(count), setting[1])
		count++
	}
	os.Setenv("GIT_CONFIG_COUNT", strconv.Itoa(count))
}
