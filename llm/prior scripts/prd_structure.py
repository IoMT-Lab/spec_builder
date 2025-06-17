from dataclasses import dataclass
from typing import List, Optional

@dataclass
class PRDSection:
    title: str
    description: str
    subtopics: List['PRDSection']
    parent: Optional['PRDSection'] = None
    content: str = ""
    depth: int = 0

class PRDStructure:
    def __init__(self):
        self.sections: List[PRDSection] = []
        
    def add_section(self, section: PRDSection, parent_title: str = None) -> None:
        if parent_title is None:
            self.sections.append(section)
        else:
            parent = self._find_section(parent_title)
            if parent:
                section.parent = parent
                parent.subtopics.append(section)
                
    def _find_section(self, title: str) -> Optional[PRDSection]:
        def search(sections: List[PRDSection]) -> Optional[PRDSection]:
            for section in sections:
                if section.title.lower() == title.lower():
                    return section
                result = search(section.subtopics)
                if result:
                    return result
            return None
        return search(self.sections)

    def get_all_sections(self) -> List[PRDSection]:
        result = []
        def collect(sections: List[PRDSection], depth: int = 0):
            for section in sections:
                section.depth = depth
                result.append(section)
                collect(section.subtopics, depth + 1)
        collect(self.sections)
        return result