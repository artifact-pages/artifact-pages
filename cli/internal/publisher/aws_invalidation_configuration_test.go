package publisher

import "testing"

func TestAWSBackendStorageOnlySetup(t *testing.T) {
	backend, err := newAWSBackend(awsClients{s3: newFakeS3()}, AWSOptions{Bucket: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	if backend == nil {
		t.Fatal("backend is nil")
	}
}
