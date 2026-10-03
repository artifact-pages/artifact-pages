package publisher

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"sync/atomic"
)

const sitePublishPutConcurrency = 8

func applySitePlan(ctx context.Context, backend DeploymentBackend, desired []desiredSiteObject, changes []Change, stale []string) (int, int, error) {
	changed := make(map[string]struct{}, len(changes))
	for _, change := range changes {
		if change.Action == "create" || change.Action == "update" {
			changed[change.Path] = struct{}{}
		}
	}

	sources := make([]desiredSiteObject, 0)
	searchBlobs := make([]desiredSiteObject, 0)
	serial := make([]desiredSiteObject, 0)
	for _, object := range desired {
		if _, shouldPut := changed[object.key]; !shouldPut {
			continue
		}
		switch {
		case strings.HasPrefix(object.key, "_artifacts/"):
			sources = append(sources, object)
		case strings.HasPrefix(object.key, "_indexes/") && strings.Contains(object.key, "/search/") && strings.HasSuffix(object.key, ".gz"):
			searchBlobs = append(searchBlobs, object)
		default:
			serial = append(serial, object)
		}
	}

	filesPublished := 0
	for _, phase := range [][]desiredSiteObject{sources, searchBlobs} {
		phaseCount, err := applySitePublishPutPhase(ctx, backend, phase)
		filesPublished += phaseCount
		if err != nil {
			return filesPublished, 0, err
		}
	}
	for _, object := range serial {
		if err := putSitePublishObject(ctx, backend, object); err != nil {
			return filesPublished, 0, fmt.Errorf("publish %s: %w", object.key, err)
		}
		filesPublished++
	}
	if err := ctx.Err(); err != nil {
		return filesPublished, 0, err
	}
	if len(stale) > 0 {
		if err := backend.DeleteObjects(ctx, stale); err != nil {
			return filesPublished, 0, fmt.Errorf("remove stale site objects: %w", err)
		}
		if err := ctx.Err(); err != nil {
			return filesPublished, 0, err
		}
	}
	return filesPublished, len(stale), nil
}

func applySitePublishPutPhase(parentCtx context.Context, backend DeploymentBackend, objects []desiredSiteObject) (int, error) {
	if len(objects) == 0 {
		return 0, parentCtx.Err()
	}
	workerCtx, cancel := context.WithCancel(parentCtx)
	defer cancel()
	jobs := make(chan desiredSiteObject)
	workers := min(sitePublishPutConcurrency, len(objects))
	var wait sync.WaitGroup
	var successes atomic.Int64
	var firstErr error
	var firstErrOnce sync.Once
	wait.Add(workers)
	for range workers {
		go func() {
			defer wait.Done()
			for object := range jobs {
				if workerCtx.Err() != nil {
					continue
				}
				if err := putSitePublishObject(workerCtx, backend, object); err != nil {
					parentErr := parentCtx.Err()
					if workerCtx.Err() != nil && parentErr == nil {
						// A peer already captured the initiating failure and
						// canceled this request. Preserve that first cause.
						continue
					}
					if parentErr != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)) {
						continue
					}
					firstErrOnce.Do(func() {
						firstErr = fmt.Errorf("publish %s: %w", object.key, err)
						// Save the originating error before canceling siblings.
						cancel()
					})
					continue
				}
				successes.Add(1)
			}
		}()
	}

dispatch:
	for _, object := range objects {
		select {
		case <-workerCtx.Done():
			break dispatch
		case jobs <- object:
		}
	}
	close(jobs)
	// Some adapters may return only after an in-flight request finishes even
	// when its context is canceled. Join every worker before the site lock can
	// be released or the pending journal can be retried.
	wait.Wait()
	if firstErr != nil {
		return int(successes.Load()), firstErr
	}
	if err := parentCtx.Err(); err != nil {
		return int(successes.Load()), err
	}
	return int(successes.Load()), nil
}

func putSitePublishObject(ctx context.Context, backend DeploymentBackend, object desiredSiteObject) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	data := object.data
	if object.sourcePath != "" {
		contents, err := os.ReadFile(object.sourcePath)
		if err != nil {
			return fmt.Errorf("read site source %s before publish: %w", object.relative, err)
		}
		if sha256Hex(contents) != object.digest {
			return fmt.Errorf("site source %s changed while preparing publish; retry with a stable working tree", object.relative)
		}
		data = contents
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	upload := object.object
	upload.Bytes = data
	upload.Metadata = cloneObjectMetadata(object.object.Metadata)
	if upload.Metadata == nil {
		upload.Metadata = make(map[string]string)
	}
	upload.Metadata["artifact-pages-sha256"] = object.digest
	return backend.PutObject(ctx, object.key, upload)
}
