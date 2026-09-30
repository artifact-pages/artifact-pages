package indexer

import (
	"strings"
	"unicode"
	"unicode/utf16"

	"golang.org/x/text/cases"
	"golang.org/x/text/language"
)

const paletteScoringProfileThreshold = 5_000

var paletteProfileIgnoredWords = map[string]struct{}{
	"the": {}, "and": {}, "for": {}, "with": {}, "from": {}, "into": {}, "index": {}, "html": {}, "md": {},
	"incidents": {}, "architecture": {}, "reports": {}, "guides": {}, "runbooks": {}, "diagrams": {}, "docs": {},
}

// PaletteScoringProfile stores shared-word and shared-folder features in CSR
// form. It is emitted only for large indexes so ordinary indexes stay small.
type PaletteScoringProfile struct {
	Version       int      `json:"version"`
	WordOffsets   []uint32 `json:"wordOffsets"`
	WordIDs       any      `json:"wordIds"`
	WordIDWidth   int      `json:"wordIdWidth"`
	FolderOffsets []uint32 `json:"folderOffsets"`
	FolderIDs     any      `json:"folderIds"`
	FolderIDWidth int      `json:"folderIdWidth"`
}

func buildPaletteScoringProfile(artifacts []ArtifactIndexEntry) PaletteScoringProfile {
	lower := cases.Lower(language.Und)
	wordDictionary := make(map[string]uint32)
	folderDictionary := make(map[string]uint32)
	wordOffsets := make([]uint32, 1, len(artifacts)+1)
	folderOffsets := make([]uint32, 1, len(artifacts)+1)
	wordIDs := make([]uint32, 0, len(artifacts)*4)
	folderIDs := make([]uint32, 0, len(artifacts)*2)

	for _, artifact := range artifacts {
		seenWords := make(map[string]struct{})
		for _, value := range []string{artifact.Title, artifact.Path} {
			for _, word := range paletteProfileWords(value, lower) {
				if _, exists := seenWords[word]; exists {
					continue
				}
				seenWords[word] = struct{}{}
				wordIDs = append(wordIDs, internPaletteFeature(wordDictionary, word))
			}
		}
		wordOffsets = append(wordOffsets, uint32(len(wordIDs)))

		folders := strings.Split(artifact.Path, "/")
		for _, folder := range folders[:max(0, len(folders)-1)] {
			if folder != "" {
				folderIDs = append(folderIDs, internPaletteFeature(folderDictionary, folder))
			}
		}
		folderOffsets = append(folderOffsets, uint32(len(folderIDs)))
	}

	wordWidth := 16
	var packedWords any = packPaletteIDs16(wordIDs)
	if len(wordDictionary) > 1<<16 {
		wordWidth = 32
		packedWords = wordIDs
	}
	folderWidth := 16
	var packedFolders any = packPaletteIDs16(folderIDs)
	if len(folderDictionary) > 1<<16 {
		folderWidth = 32
		packedFolders = folderIDs
	}

	return PaletteScoringProfile{
		Version:       1,
		WordOffsets:   wordOffsets,
		WordIDs:       packedWords,
		WordIDWidth:   wordWidth,
		FolderOffsets: folderOffsets,
		FolderIDs:     packedFolders,
		FolderIDWidth: folderWidth,
	}
}

func internPaletteFeature(dictionary map[string]uint32, value string) uint32 {
	if id, exists := dictionary[value]; exists {
		return id
	}
	id := uint32(len(dictionary))
	dictionary[value] = id
	return id
}

func packPaletteIDs16(values []uint32) []uint16 {
	packed := make([]uint16, len(values))
	for index, value := range values {
		packed[index] = uint16(value)
	}
	return packed
}

func paletteProfileWords(value string, lower cases.Caser) []string {
	lowerText := lower.String(value)
	words := make([]string, 0)
	var current strings.Builder
	flush := func() {
		word := current.String()
		current.Reset()
		if len(utf16.Encode([]rune(word))) < 4 {
			return
		}
		if _, ignored := paletteProfileIgnoredWords[word]; ignored {
			return
		}
		words = append(words, word)
	}

	for _, character := range lowerText {
		if unicode.IsLetter(character) || unicode.IsNumber(character) {
			current.WriteRune(character)
		} else if current.Len() > 0 {
			flush()
		}
	}
	if current.Len() > 0 {
		flush()
	}
	return words
}
