//go:build unix

package publisher

import "syscall"

func syscallUmask(mask int) int { return syscall.Umask(mask) }
