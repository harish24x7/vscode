/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { DisposableStore, toDisposable } from 'vs/base/common/lifecycle';
import { IUserDataProfilesService } from 'vs/platform/userDataProfile/common/userDataProfile';
import { UserDataProfilesManifestSynchroniser } from 'vs/platform/userDataSync/common/userDataProfilesManifestSync';
import { ISyncData, ISyncUserDataProfile, IUserDataSyncStoreService, SyncResource, SyncStatus } from 'vs/platform/userDataSync/common/userDataSync';
import { UserDataSyncClient, UserDataSyncTestServer } from 'vs/platform/userDataSync/test/common/userDataSyncClient';

suite('UserDataProfilesManifestSync', () => {

	const disposableStore = new DisposableStore();
	const server = new UserDataSyncTestServer();
	let testClient: UserDataSyncClient;
	let client2: UserDataSyncClient;

	let testObject: UserDataProfilesManifestSynchroniser;

	setup(async () => {
		testClient = disposableStore.add(new UserDataSyncClient(server));
		await testClient.setUp(true);
		testObject = testClient.getSynchronizer(SyncResource.Profiles) as UserDataProfilesManifestSynchroniser;
		disposableStore.add(toDisposable(() => testClient.instantiationService.get(IUserDataSyncStoreService).clear()));

		client2 = disposableStore.add(new UserDataSyncClient(server));
		await client2.setUp(true);
	});

	teardown(() => disposableStore.clear());

	test('when profiles does not exist', async () => {
		assert.deepStrictEqual(await testObject.getLastSyncUserData(), null);
		let manifest = await testClient.manifest();
		server.reset();
		await testObject.sync(manifest);

		assert.deepStrictEqual(server.requests, [
			{ type: 'GET', url: `${server.url}/v1/resource/${testObject.resource}/latest`, headers: {} },
		]);

		const lastSyncUserData = await testObject.getLastSyncUserData();
		const remoteUserData = await testObject.getRemoteUserData(null);
		assert.deepStrictEqual(lastSyncUserData!.ref, remoteUserData.ref);
		assert.deepStrictEqual(lastSyncUserData!.syncData, remoteUserData.syncData);
		assert.strictEqual(lastSyncUserData!.syncData, null);

		manifest = await testClient.manifest();
		server.reset();
		await testObject.sync(manifest);
		assert.deepStrictEqual(server.requests, []);

		manifest = await testClient.manifest();
		server.reset();
		await testObject.sync(manifest);
		assert.deepStrictEqual(server.requests, []);
	});

	test('when profile is created after first sync', async () => {
		await testObject.sync(await testClient.manifest());
		await testClient.instantiationService.get(IUserDataProfilesService).createProfile('1', '1');

		let lastSyncUserData = await testObject.getLastSyncUserData();
		const manifest = await testClient.manifest();
		server.reset();
		await testObject.sync(manifest);

		assert.deepStrictEqual(server.requests, [
			{ type: 'POST', url: `${server.url}/v1/collection`, headers: {} },
			{ type: 'POST', url: `${server.url}/v1/resource/${testObject.resource}`, headers: { 'If-Match': lastSyncUserData?.ref } },
		]);

		lastSyncUserData = await testObject.getLastSyncUserData();
		const remoteUserData = await testObject.getRemoteUserData(null);
		assert.deepStrictEqual(lastSyncUserData!.ref, remoteUserData.ref);
		assert.deepStrictEqual(lastSyncUserData!.syncData, remoteUserData.syncData);
		assert.deepStrictEqual(JSON.parse(lastSyncUserData!.syncData!.content), [{ 'name': '1', 'id': '1', 'collection': '1' }]);
	});

	test('first time sync - outgoing to server (no state)', async () => {
		await testClient.instantiationService.get(IUserDataProfilesService).createProfile('1', '1');

		await testObject.sync(await testClient.manifest());
		assert.strictEqual(testObject.status, SyncStatus.Idle);
		assert.deepStrictEqual(testObject.conflicts, []);

		const { content } = await testClient.read(testObject.resource);
		assert.ok(content !== null);
		assert.deepStrictEqual(JSON.parse(JSON.parse(content).content), [{ 'name': '1', 'id': '1', 'collection': '1' }]);
	});

	test('first time sync - incoming from server (no state)', async () => {
		await client2.instantiationService.get(IUserDataProfilesService).createProfile('1', 'name 1');
		await client2.sync();

		await testObject.sync(await testClient.manifest());
		assert.strictEqual(testObject.status, SyncStatus.Idle);
		assert.deepStrictEqual(testObject.conflicts, []);

		const profiles = getLocalProfiles(testClient);
		assert.deepStrictEqual(profiles, [{ id: '1', name: 'name 1' }]);
	});

	test('first time sync when profiles exists', async () => {
		await client2.instantiationService.get(IUserDataProfilesService).createProfile('1', 'name 1');
		await client2.sync();

		await testClient.instantiationService.get(IUserDataProfilesService).createProfile('2', 'name 2');
		await testObject.sync(await testClient.manifest());
		assert.strictEqual(testObject.status, SyncStatus.Idle);
		assert.deepStrictEqual(testObject.conflicts, []);

		const profiles = getLocalProfiles(testClient);
		assert.deepStrictEqual(profiles, [{ id: '1', name: 'name 1' }, { id: '2', name: 'name 2' }]);

		const { content } = await testClient.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseRemoteProfiles(content!);
		assert.deepStrictEqual(actual, [{ id: '1', name: 'name 1', collection: '1' }, { id: '2', name: 'name 2', collection: '2' }]);
	});

	test('first time sync when storage exists - has conflicts', async () => {
		await client2.instantiationService.get(IUserDataProfilesService).createProfile('1', 'name 1');
		await client2.sync();

		await testClient.instantiationService.get(IUserDataProfilesService).createProfile('1', 'name 2');
		await testObject.sync(await testClient.manifest());

		assert.strictEqual(testObject.status, SyncStatus.Idle);
		assert.deepStrictEqual(testObject.conflicts, []);

		const profiles = getLocalProfiles(testClient);
		assert.deepStrictEqual(profiles, [{ id: '1', name: 'name 1' }]);

		const { content } = await testClient.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseRemoteProfiles(content!);
		assert.deepStrictEqual(actual, [{ id: '1', name: 'name 1', collection: '1' }]);
	});

	test('sync adding a profile', async () => {
		await testClient.instantiationService.get(IUserDataProfilesService).createProfile('1', 'name 1');
		await testObject.sync(await testClient.manifest());
		await client2.sync();

		await testClient.instantiationService.get(IUserDataProfilesService).createProfile('2', 'name 2');
		await testObject.sync(await testClient.manifest());
		assert.strictEqual(testObject.status, SyncStatus.Idle);
		assert.deepStrictEqual(testObject.conflicts, []);
		assert.deepStrictEqual(getLocalProfiles(testClient), [{ id: '1', name: 'name 1' }, { id: '2', name: 'name 2' }]);

		await client2.sync();
		assert.deepStrictEqual(getLocalProfiles(client2), [{ id: '1', name: 'name 1' }, { id: '2', name: 'name 2' }]);

		const { content } = await testClient.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseRemoteProfiles(content!);
		assert.deepStrictEqual(actual, [{ id: '1', name: 'name 1', collection: '1' }, { id: '2', name: 'name 2', collection: '2' }]);
	});

	test('sync updating a profile', async () => {
		const profile = await testClient.instantiationService.get(IUserDataProfilesService).createProfile('1', 'name 1');
		await testObject.sync(await testClient.manifest());
		await client2.sync();

		await testClient.instantiationService.get(IUserDataProfilesService).updateProfile(profile, 'name 2');
		await testObject.sync(await testClient.manifest());
		assert.strictEqual(testObject.status, SyncStatus.Idle);
		assert.deepStrictEqual(testObject.conflicts, []);
		assert.deepStrictEqual(getLocalProfiles(testClient), [{ id: '1', name: 'name 2' }]);

		await client2.sync();
		assert.deepStrictEqual(getLocalProfiles(client2), [{ id: '1', name: 'name 2' }]);

		const { content } = await testClient.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseRemoteProfiles(content!);
		assert.deepStrictEqual(actual, [{ id: '1', name: 'name 2', collection: '1' }]);
	});

	test('sync removing a profile', async () => {
		const profile = await testClient.instantiationService.get(IUserDataProfilesService).createProfile('1', 'name 1');
		await testClient.instantiationService.get(IUserDataProfilesService).createProfile('2', 'name 2');
		await testObject.sync(await testClient.manifest());
		await client2.sync();

		testClient.instantiationService.get(IUserDataProfilesService).removeProfile(profile);
		await testObject.sync(await testClient.manifest());
		assert.strictEqual(testObject.status, SyncStatus.Idle);
		assert.deepStrictEqual(testObject.conflicts, []);
		assert.deepStrictEqual(getLocalProfiles(testClient), [{ id: '2', name: 'name 2' }]);

		await client2.sync();
		assert.deepStrictEqual(getLocalProfiles(client2), [{ id: '2', name: 'name 2' }]);

		const { content } = await testClient.read(testObject.resource);
		assert.ok(content !== null);
		const actual = parseRemoteProfiles(content!);
		assert.deepStrictEqual(actual, [{ id: '2', name: 'name 2', collection: '2' }]);
	});

	function parseRemoteProfiles(content: string): ISyncUserDataProfile[] {
		const syncData: ISyncData = JSON.parse(content);
		return JSON.parse(syncData.content);
	}

	function getLocalProfiles(client: UserDataSyncClient): { id: string; name: string }[] {
		return client.instantiationService.get(IUserDataProfilesService).profiles
			.slice(1).sort((a, b) => a.name.localeCompare(b.name))
			.map(profile => ({ id: profile.id, name: profile.name }));
	}


});
