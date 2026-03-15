import httpx
from typing import Optional
from app.config import settings


class StashClient:
    def __init__(self):
        self.url = settings.stash_url
        self.api_key = settings.stash_api_key

    def _headers(self) -> dict:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["ApiKey"] = self.api_key
        return headers

    async def _query(self, query: str, variables: dict = None) -> dict:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{self.url}/graphql",
                json={"query": query, "variables": variables or {}},
                headers=self._headers(),
                timeout=30.0,
            )
            response.raise_for_status()
            result = response.json()
            if "errors" in result:
                raise Exception(f"GraphQL errors: {result['errors']}")
            return result.get("data", {})

    async def get_scene(self, scene_id: str) -> Optional[dict]:
        query = """
        query FindScene($id: ID) {
            findScene(id: $id) {
                id
                title
                files {
                    path
                }
                tags {
                    id
                    name
                }
            }
        }
        """
        result = await self._query(query, {"id": scene_id})
        return result.get("findScene")

    async def scan_path(self, path: str) -> str:
        """Trigger a metadata scan for a specific path. Returns job ID."""
        query = """
        mutation MetadataScan($input: ScanMetadataInput!) {
            metadataScan(input: $input)
        }
        """
        result = await self._query(query, {"input": {"paths": [path]}})
        return result.get("metadataScan")

    async def find_job(self, job_id: str) -> Optional[dict]:
        """Find a job by ID."""
        query = """
        query FindJob($input: FindJobInput!) {
            findJob(input: $input) {
                id
                status
                progress
                description
                error
            }
        }
        """
        result = await self._query(query, {"input": {"id": job_id}})
        return result.get("findJob")

    async def find_scene_by_path(self, path: str) -> Optional[dict]:
        """Find a scene by file path."""
        query = """
        query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
            findScenes(filter: $filter, scene_filter: $scene_filter) {
                scenes {
                    id
                    title
                    files {
                        path
                    }
                    tags {
                        id
                        name
                    }
                }
            }
        }
        """
        result = await self._query(
            query,
            {
                "filter": {"per_page": 1},
                "scene_filter": {
                    "path": {"value": path, "modifier": "EQUALS"}
                }
            }
        )
        scenes = result.get("findScenes", {}).get("scenes", [])
        return scenes[0] if scenes else None

    async def merge_scenes(
        self,
        source_ids: list[str],
        destination_id: str,
        play_history: bool = True,
        o_history: bool = True
    ) -> Optional[dict]:
        """Merge source scenes into destination scene."""
        query = """
        mutation SceneMerge($input: SceneMergeInput!) {
            sceneMerge(input: $input) {
                id
            }
        }
        """
        result = await self._query(
            query,
            {
                "input": {
                    "source": source_ids,
                    "destination": destination_id,
                    "values": {
                        "play_history": play_history,
                        "o_history": o_history
                    }
                }
            }
        )
        return result.get("sceneMerge")

    async def update_scene_tags(
        self,
        scene_id: str,
        tag_ids: list[str]
    ) -> Optional[dict]:
        """Update scene tags."""
        query = """
        mutation SceneUpdate($input: SceneUpdateInput!) {
            sceneUpdate(input: $input) {
                id
                tags {
                    id
                    name
                }
            }
        }
        """
        result = await self._query(
            query,
            {
                "input": {
                    "id": scene_id,
                    "tag_ids": tag_ids
                }
            }
        )
        return result.get("sceneUpdate")


stash_client = StashClient()
