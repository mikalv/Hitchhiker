import { StringUtil } from '../utils/string_util';
import { User } from '../models/user';
import { ConnectionManager } from './connection_manager';
import { Message } from '../common/message';
import { ResObject } from '../common/res_object';
import { UserCollectionService } from './user_collection_service';
import { StressRecordService } from './stress_record_service';
import { ObjectLiteral } from 'typeorm/common/ObjectLiteral';
import { DtoStress } from '../interfaces/dto_stress';
import { Stress } from '../models/stress';
import { StressRecord } from '../models/stress_record';
import { TestCase, RequestBody } from '../interfaces/dto_stress_setting';
import { RecordService } from './record_service';
import * as _ from 'lodash';
import { RecordRunner } from '../run_engine/record_runner';

export class StressService {

    static fromDto(dtoStress: DtoStress): Stress {
        const stress = new Stress();
        stress.collectionId = dtoStress.collectionId;
        stress.environmentId = dtoStress.environmentId;
        stress.emails = dtoStress.emails;
        stress.id = dtoStress.id || StringUtil.generateUID();
        stress.name = dtoStress.name;
        stress.notification = dtoStress.notification;
        stress.concurrencyCount = dtoStress.concurrencyCount;
        stress.totalCount = dtoStress.totalCount;
        stress.qps = dtoStress.qps;
        stress.timeout = dtoStress.timeout;
        stress.requests = dtoStress.requests;
        return stress;
    }

    static toDto(stress: Stress): DtoStress {
        return <DtoStress>{
            ...stress,
            stressRecords: stress.stressRecords ? stress.stressRecords.map(s => StressRecordService.toDto(s)) : [],
            ownerId: stress.ownerId
        };
    }

    static async save(stress: Stress): Promise<any> {
        const connection = await ConnectionManager.getInstance();
        await connection.getRepository(Stress).persist(stress);
    }

    static async getById(id: string): Promise<Stress> {
        const connection = await ConnectionManager.getInstance();

        return await connection.getRepository(Stress)
            .createQueryBuilder('stress')
            .where('stress.id=:id', { id: id })
            .getOne();
    }

    static async getByUserId(userId: string): Promise<Stress[]> {
        const collections = await UserCollectionService.getUserProjectCollections(userId);
        if (!collections || collections.length === 0) {
            return [];
        }
        const collectionIds = collections.map(c => c.id);
        const connection = await ConnectionManager.getInstance();

        const parameters: ObjectLiteral = {};
        const whereStrings = collectionIds.map((id, index) => {
            parameters[`id_${index}`] = id;
            return `collectionId=:id_${index}`;
        });
        const whereStr = whereStrings.length > 1 ? '(' + whereStrings.join(' OR ') + ')' : whereStrings[0];

        return await connection.getRepository(Stress)
            .createQueryBuilder('stress')
            .leftJoinAndSelect('stress.stressRecords', 'record')
            .where(whereStr, parameters)
            .getMany();
    }

    static async createNew(dtoStress: DtoStress, owner: User): Promise<ResObject> {
        const stress = StressService.fromDto(dtoStress);
        stress.ownerId = owner.id;
        await StressService.save(stress);
        return { message: Message.stressCreateSuccess, success: true };
    }

    static async update(dtoStress: DtoStress): Promise<ResObject> {
        const stress = StressService.fromDto(dtoStress);
        await StressService.save(stress);
        return { message: Message.stressUpdateSuccess, success: true };
    }

    static async delete(id: string): Promise<ResObject> {
        const connection = await ConnectionManager.getInstance();
        await connection.transaction(async manager => {
            await manager.createQueryBuilder(StressRecord, 'stressRecord')
                .where('stressId=:id', { id })
                .delete()
                .execute();
            await manager.createQueryBuilder(Stress, 'stress')
                .where('id=:id', { id })
                .delete()
                .execute();
        });
        await connection.getRepository(Stress)
            .createQueryBuilder('stress')
            .where('id=:id', { id })
            .delete()
            .execute();
        return { success: true, message: Message.stressDeleteSuccess };
    }

    static async getTestCase(id: string): Promise<ResObject> {
        const stress = await StressService.getById(id);
        if (!stress) {
            return { success: false, message: Message.stressNotExist };
        }
        const collectionRecords = await RecordService.getByCollectionIds([stress.collectionId]);
        const records = _.keyBy((collectionRecords ? collectionRecords[stress.collectionId] : []).filter(r => stress.requests.some(i => i === r.id)), 'id');
        if (_.keys(records).length === 0) {
            return { success: false, message: Message.stressNoRecords };
        }

        const requestBodyList = new Array<RequestBody>();
        stress.requests.forEach(i => {
            let record = records[i];
            const paramArr = StringUtil.parseParameters(record.parameters, record.parameterType);
            const headers = {};

            if (paramArr.length === 0) {
                record.headers.forEach(h => headers[h.key] = h.value);
                requestBodyList.push(<any>{ ...record, headers });
            } else {
                for (let param of paramArr) {
                    record = RecordRunner.applyReqParameterToRecord(record, param);
                    record.headers.forEach(h => headers[h.key] = h.value);
                    requestBodyList.push(<any>{ ...record, headers });
                }
            }
        });
        return {
            success: true,
            message: '',
            result: <TestCase>{
                totalCount: stress.totalCount,
                concurrencyCount: stress.concurrencyCount,
                qps: stress.qps,
                timeout: stress.timeout,
                requestBodyList
            }
        };
    }
}