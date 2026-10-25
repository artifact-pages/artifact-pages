package publisher

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestCloudflareExplicitR2PairNeedsNoAPIRequest(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		http.Error(w, "unexpected API request", http.StatusForbidden)
	}))
	defer server.Close()
	options := cloudflareTokenTestOptions(server.URL)
	options.AccessKeyID, options.SecretKey = "explicit-access", "explicit-secret"
	options.APIToken, options.APITokenProvider = "", nil
	if _, err := NewCloudflareBackend(context.Background(), options); err != nil {
		t.Fatal(err)
	}
	if requests != 0 {
		t.Fatalf("API requests = %d, want zero for explicit R2 credentials", requests)
	}
}
