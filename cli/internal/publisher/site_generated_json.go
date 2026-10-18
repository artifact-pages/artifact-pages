package publisher

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
)

const maxPriorSiteIndexJSONBytes = 512 << 20

// decodeSiteGeneratedJSON reads the stored representation of a generated site
// JSON object. Gzip data is restricted to one complete member with no trailing
// bytes, and both representations share the same decoded-size limit.
func decodeSiteGeneratedJSON(stored []byte, encoding string) ([]byte, error) {
	return decodeSiteGeneratedJSONWithLimit(stored, encoding, maxPriorSiteIndexJSONBytes)
}

func decodeSiteGeneratedJSONWithLimit(stored []byte, encoding string, maxDecoded int64) ([]byte, error) {
	if maxDecoded < 0 {
		return nil, errors.New("decoded site JSON size limit must not be negative")
	}
	if encoding == "" {
		if int64(len(stored)) > maxDecoded {
			return nil, fmt.Errorf("decoded site JSON exceeds %d bytes", maxDecoded)
		}
		return stored, nil
	}
	if encoding != "gzip" {
		return nil, fmt.Errorf("unsupported generated site JSON content encoding %q", encoding)
	}
	source := bytes.NewReader(stored)
	reader, err := gzip.NewReader(source)
	if err != nil {
		return nil, fmt.Errorf("open generated site JSON gzip: %w", err)
	}
	reader.Multistream(false)
	plain, readErr := io.ReadAll(io.LimitReader(reader, maxDecoded+1))
	closeErr := reader.Close()
	if readErr != nil {
		return nil, fmt.Errorf("read generated site JSON gzip: %w", readErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close generated site JSON gzip: %w", closeErr)
	}
	if int64(len(plain)) > maxDecoded {
		return nil, fmt.Errorf("decoded site JSON exceeds %d bytes", maxDecoded)
	}
	if source.Len() != 0 {
		return nil, errors.New("generated site JSON gzip has trailing data or multiple members")
	}
	return plain, nil
}
