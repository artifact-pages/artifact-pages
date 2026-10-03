// Command gomodzip checks that a directory can be published as the root Go
// module: `go install …/cli/cmd/artifact-pages@vX.Y.Z` fails for every user if
// the module zip would contain a file name Go rejects.
package main

import (
	"fmt"
	"os"

	"golang.org/x/mod/zip"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: gomodzip DIR")
		os.Exit(2)
	}
	files, err := zip.CheckDir(os.Args[1])
	for _, file := range files.Invalid {
		fmt.Fprintf(os.Stderr, "invalid: %s: %v\n", file.Path, file.Err)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("Go module zip check passed: %d files, %d omitted.\n", len(files.Valid), len(files.Omitted))
}
